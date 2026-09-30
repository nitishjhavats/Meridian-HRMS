import path from "node:path";
import { buildId } from "./scripts/build-id.mjs";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Content Security Policy.
 *
 * Deliberately not nonce-based: a nonce needs middleware to mint one per
 * request, and this app has no middleware. What is here still earns its keep —
 * `connect-src 'self'` and `script-src 'self'` mean a script injected through an
 * announcement or a letter cannot call out to somebody else's server, which is
 * the attack that actually matters for a product holding payroll.
 *
 * `unsafe-eval` is development only; React Refresh needs it and production does
 * not. `blob:` appears in `img-src` and `media-src` for the attendance camera,
 * and `data:` for the QR codes, which are generated in the browser.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Nothing needs this today — there is no mixed content. It is here so that a
  // future stray http:// subresource is upgraded instead of quietly turning the
  // padlock off and costing another afternoon to diagnose.
  "upgrade-insecure-requests",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * Which build is on the screen.
   *
   * The same id the service worker stamps its cache with, inlined at build time
   * so a page can print it. Without this the only build identity reaching a
   * client was `CACHE_VERSION` inside `/sw.js`, which nobody standing in front
   * of a reception tablet can read — so "is that device on the old build?" was
   * answered by argument rather than by looking.
   */
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId(),
  },

  // Produces `.next/standalone` — a self-contained server plus only the
  // node_modules it traced. The Dockerfile copies the native packages in by
  // hand on top of it; see the comment there.
  output: "standalone",

  // Packages Next must not bundle. `sharp` and `onnxruntime-node` carry native
  // binaries a bundler cannot rewrite, and both are loaded through
  // `await import()` at the point of use. `@react-pdf/renderer` is a top-level
  // import that reaches two server pages, so Next evaluates it while collecting
  // page data at build time; it ships binary font metrics that webpack cannot
  // bundle, and the build fails there rather than at runtime.
  serverExternalPackages: [
    "@prisma/client",
    "bcryptjs",
    "sharp",
    "onnxruntime-node",
    "@react-pdf/renderer",
  ],

  // `@react-pdf/renderer` loads pdfkit's standard fonts by name at runtime, so
  // the tracer never sees the files and leaves them behind. The symptom is an
  // unhandled "Cannot find module .../standard-fonts/Helvetica.cjs" at boot and
  // every payslip, letter and settlement PDF failing — while the health check
  // still reports the app as fine.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdfkit/js/**"],
  },

  // The image is linux/amd64 and glibc. Everything else the lockfile carries —
  // musl builds, arm64, Windows, macOS — is dead weight the tracer would
  // otherwise copy into `.next/standalone`, and it is not small: the arm64 ONNX
  // runtime alone is 33 MB and the musl libvips another 18 MB.
  //
  // Written as plain patterns rather than brace expansions, which were verified
  // not to match here.
  outputFileTracingExcludes: {
    "/**": [
      "./node_modules/@img/sharp-libvips-linuxmusl-x64/**",
      "./node_modules/@img/sharp-linuxmusl-x64/**",
      "./node_modules/@img/sharp-wasm32/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/win32/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
    ],
  },

  experimental: {
    // Above the storage layer's 10 MB per-file limit, so the two stop
    // disagreeing about what is too large.
    serverActions: { bodySizeLimit: "12mb" },
  },

  /**
   * Keep the face engine out of every compilation that is not the Node server.
   *
   * `instrumentation.ts` warms the models at boot behind a
   * `NEXT_RUNTIME === "nodejs"` check, but that check runs at *runtime* while
   * webpack traces the `await import()` regardless. `onnxruntime-node` ships a
   * `.node` binary, and every non-Node compilation runs it through
   * `next-error-browser-binary-loader`, which throws. The symptom was that
   * `next dev` compiled for twenty seconds and then answered *every* route,
   * `/api/health` included, with a 500. `next build` was unaffected, so this
   * only ever broke local development -- which is the worst place for it,
   * because it broke it completely.
   *
   * Aliasing the packages was not enough; the module that reaches them has to
   * go too. `serverExternalPackages` above says the same thing to the Node
   * server, which is the only compilation that should ever load any of this.
   */
  webpack(config, { isServer, nextRuntime }) {
    const isNodeServer = isServer && nextRuntime !== "edge";
    if (!isNodeServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        [path.join(process.cwd(), "src/lib/face/engine.ts")]: false,
        "@/lib/face/engine": false,
        "onnxruntime-node": false,
        sharp: false,
      };
    }
    return config;
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), geolocation=(self), microphone=()",
          },
          { key: "Content-Security-Policy", value: csp },
          // Ignored over http, so it is safe to send in development too.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
      {
        // Everything behind a login stays out of the index, and so does every
        // API response and stored file. The marketing page at `/` is the only
        // thing deliberately left out of this list — see `robots.txt` and the
        // per-layout `robots` metadata, which say the same thing three ways.
        source: "/:path(o|api|login|change-password|forgot-password|dashboard|employees|attendance|leave|payroll|reimbursements|documents|letters|announcements|notifications|reports|onboarding|assets|performance|exit|audit|billing|settings|account|me|platform|kiosk|offline)/:rest*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
      {
        source: "/:path(login|change-password|forgot-password|dashboard|employees|attendance|leave|payroll|documents|letters|reports|audit|billing|settings|platform|kiosk|offline)",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
