# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# HRMS + Payroll PWA
#
# Debian slim rather than Alpine, deliberately: `onnxruntime-node` ships a
# prebuilt `libonnxruntime.so.1` linked against glibc, and Microsoft publishes
# no musl build of the Node binding. On Alpine it does not load, and the failure
# is a runtime "cannot open shared object file" on the first face match — long
# after the build went green.
# ---------------------------------------------------------------------------

FROM node:22.16-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1


# ---------------------------------------------------------------------- deps
FROM base AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

# Without this, onnxruntime-node's postinstall reads its own install manifest,
# sees that linux/x64 "requires" the CUDA and TensorRT execution providers,
# finds they are not in the npm tarball, and downloads hundreds of megabytes of
# GPU binaries from NuGet that a CPU-only VPS can never use. On Windows the
# manifest lists no such requirement, which is why this never bites locally.
ENV ONNXRUNTIME_NODE_INSTALL=skip

COPY package.json package-lock.json ./
# Dev dependencies are needed to build: typescript, tailwind, the prisma CLI.
RUN npm ci


# --------------------------------------------------------------------- fonts
# Its own stage for the same reason the models have one: editing a line of
# TypeScript should not re-download a megabyte of font.
#
# Without these two files every PDF falls back to Helvetica and writes money as
# "Rs" -- see `lib/pdf/fonts.ts`, which degrades deliberately rather than
# printing a glyph the font does not have. The size assertions are what turn a
# silently truncated download into a failed build.
FROM base AS fonts
WORKDIR /app
COPY scripts/download-fonts.mjs ./scripts/
RUN node scripts/download-fonts.mjs   && test "$(stat -c%s fonts/NotoSans-Regular.ttf)" -gt 400000   && test "$(stat -c%s fonts/NotoSans-Bold.ttf)" -gt 400000

# -------------------------------------------------------------------- models
# A stage of its own so editing a line of TypeScript does not re-download 38 MB.
FROM base AS models
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/download-face-models.mjs ./scripts/
# The script only compares sizes on a *later* run, so assert here. A truncated
# download would otherwise surface months later as a quiet "face engine
# unavailable" warning, which is the worst way for a biometric check to fail.
RUN node scripts/download-face-models.mjs \
  && test "$(stat -c%s models/sface.onnx)" = "38696353" \
  && test "$(stat -c%s models/yunet.onnx)" = "232589"


# ---------------------------------------------------------------- prisma CLI
# `migrate deploy` has to run somewhere, and the only place with both the
# database and the credentials is this container. The CLI cannot simply be
# copied out of the build stage: it pulls a dependency tree of its own (effect,
# c12, and their trees), and cherry-picking packages surfaces a new
# MODULE_NOT_FOUND one layer deeper each time. Installing it alone, into its own
# prefix, gives a coherent tree that cannot collide with the application's.
FROM base AS prismacli
WORKDIR /opt/prisma

RUN apt-get update   && apt-get install -y --no-install-recommends ca-certificates openssl   && rm -rf /var/lib/apt/lists/*

# The locked version, not the declared range: the CLI and the generated client
# must be the same version, and the client is generated from this lockfile.
COPY package-lock.json ./package-lock.json
RUN VERSION="$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")"   && echo "installing prisma@$VERSION"   && npm init -y > /dev/null   && npm install --no-audit --no-fund --omit=dev "prisma@$VERSION"


# --------------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app

COPY . .

# `next build` never opens a connection — every page is force-dynamic and every
# secret is read lazily inside a function — but the Prisma client wants a
# syntactically valid URL to generate against. This value is never used and is
# not a secret.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV NODE_ENV=production
# A Next build across 45 pages and 77 route handlers peaks well above the
# default heap, and an OOM on a small host presents as a build that dies without
# saying why.
ENV NODE_OPTIONS=--max-old-space-size=2048

# Stamped into the service worker by scripts/build-sw.mjs (npm `prebuild`).
# A service worker only updates when its own bytes change, so without a value
# that differs per build, no deploy ever reaches an already-installed client.
# `.git` is not in the build context, so the script cannot read HEAD itself;
# Coolify supplies SOURCE_COMMIT. If it is absent the script falls back to a
# timestamp, which is still unique per build.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=$SOURCE_COMMIT

RUN npm run build

# One self-contained file so the seed can run in the runtime image without a
# TypeScript toolchain. Everything is bundled *except* the packages carrying
# native binaries, which must resolve from node_modules at run time.
#
# Marking all packages external was tried first and fails: standalone's
# node_modules is a traced subset, so a pure-JS dependency like zod lives inside
# the server bundle and is not resolvable as a package of its own.
#
# `bcryptjs` is external for a different reason: it is CommonJS, and bundling it
# into an ES module broke its default export badly enough that every hash call
# came back "Invalid string / salt". It resolves from node_modules, so let it.
RUN npx esbuild prisma/seed.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@prisma/client --external:.prisma \
  --external:sharp --external:onnxruntime-node \
  --external:bcryptjs \
  --tsconfig=tsconfig.json \
  --outfile=dist/seed.mjs

# The one-off maintenance scripts, bundled for the same reason as the seed.
#
# They are `.mts` files run with `tsx`, which works on a developer's machine and
# nowhere else: this image ships neither TypeScript nor `tsx` (see the comment
# above the source prune below), and the database is reachable from inside this
# container and essentially nowhere else. So `mask:aadhaar` and
# `migrate:bloodgroup` sat on the operator's list across two rounds as things
# nobody could actually run, and round 4 added three more.
#
# Same externals as the seed, and every one of them for the same reason.
RUN set -eu; for script in \
      mask-aadhaar \
      migrate-blood-group \
      backfill-reporting \
      unfreeze-letters \
      enable-modules \
      set-attendance-fence \
      seed-national-holidays \
      close-attendance-days \
    ; do \
      npx esbuild scripts/$script.mts \
        --bundle \
        --platform=node \
        --format=esm \
        --target=node22 \
        --external:@prisma/client \
        --external:.prisma \
        --external:bcryptjs \
        --external:sharp \
        --external:onnxruntime-node \
        --tsconfig=tsconfig.json \
        --outfile=dist/$script.mjs; \
    done


# -------------------------------------------------------------------- runner
FROM base AS runner
WORKDIR /app

# `openssl` is what Prisma's query engine links against. `curl` is not
# decoration: Coolify's generated HEALTHCHECK shells out to it *inside* the
# container, and node:slim ships neither curl nor wget — without it the
# container is permanently unhealthy, Traefik never routes to it, and the
# deploy rolls back with a misleading error.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Attendance day boundaries and payroll periods are derived from `new Date()`,
# and `formatDate` has 46 call sites that cannot be passed a timezone. A UTC
# container renders every evening timestamp as the previous day.
ENV TZ=Asia/Kolkata
# Explicit rather than relying on the cwd-relative "./models" default: a
# scheduled task that `docker exec`s in with a different working directory
# would otherwise silently find no models.
ENV FACE_MODEL_DIR=/app/models
# Same reasoning for the PDF font: a cwd-relative default is one `docker exec`
# away from every payslip quietly reverting to "Rs".
ENV PDF_FONT_DIR=/app/fonts

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=models --chown=node:node /app/models ./models
COPY --from=fonts --chown=node:node /app/fonts ./fonts

# Nothing else from node_modules is copied. Next's file tracer was checked
# rather than assumed, and `.next/standalone/node_modules` already carries the
# lot: sharp with its libvips, onnxruntime-node with the linux `.so`, and
# `.prisma/client` with `libquery_engine-debian-openssl-3.0.x.so.node`. Copying
# them again on top added about 260 MB of duplicate layers.

# The exception is migrations: `migrate deploy` needs the *schema* engine, which
# lives in the CLI rather than in the generated client. It goes in its own prefix
# so it shares nothing with the application's node_modules.
COPY --from=prismacli --chown=node:node /opt/prisma /opt/prisma
COPY --from=build --chown=node:node /app/prisma ./prisma

# The demo seed and the six one-off maintenance scripts, each bundled to a
# single file at build time.
#
# They need to run *inside* this container, because the database and the
# service-role key are reachable from nowhere else. Shipping `tsx` and the
# TypeScript sources to do that would cost 40 MB and put a compiler in
# production; seven bundled files cost a few hundred kilobytes together.
#
# Not loaded guns. `prisma/seed.ts` refuses to run without
# ALLOW_DESTRUCTIVE_SEED=1, which production never sets, and every maintenance
# script is a dry run until it is given `--apply`. `docs/06-operations.md` has
# the command for each.
COPY --from=build --chown=node:node /app/dist ./dist

# Migrations run here, on every start. See the script for why not in the
# platform's pre-deployment hook.
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
