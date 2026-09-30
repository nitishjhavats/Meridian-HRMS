#!/bin/sh
#
# Applies pending migrations, then starts the server.
#
# This lives in the entrypoint rather than in the platform's pre-deployment
# hook, because that hook runs inside an *already running* container. On a first
# deploy there is none, so it is skipped entirely and the database is never
# migrated; on later deploys it runs against the previous image, which is the
# wrong code for a new migration. Both failures are silent — the deployment goes
# green and the schema is simply wrong.
#
# Here it runs in the image it belongs to, every time, before anything serves a
# request. `migrate deploy` is a no-op when there is nothing to apply, and it
# takes a Postgres advisory lock, so two containers starting together during a
# rolling deploy cannot race each other.
#
# A failed migration exits non-zero and the container does not start. That is
# deliberate: serving payroll against a schema the code does not expect is worse
# than being down.

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] DATABASE_URL is not set — refusing to start." >&2
  exit 1
fi

echo "[entrypoint] applying migrations…"
node /opt/prisma/node_modules/prisma/build/index.js migrate deploy --schema /app/prisma/schema.prisma

echo "[entrypoint] starting the server"
exec node server.js
