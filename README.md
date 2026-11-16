# Meridian HRMS

<sub>**Meridian HRMS by Broadmate Global** — open-source HR, attendance and payroll PWA for Indian companies</sub>

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> **Don't want to run servers?** A fully managed version is available at
> **[hrms.broadmate.org](https://hrms.broadmate.org)** — sign up, add your people, run payroll.
> This repository is the same product you can self-host for free under the AGPL.

Multi-tenant HR, attendance, leave and payroll. One deployment serves many
organisations, each running its own attendance thresholds, week-off patterns,
holidays, leave types, salary structures and payroll rules **without any code
change**.

Installable as a PWA on desktop and mobile.

---

## Quick start

```bash
docker compose up -d      # Postgres 16 on :5432 (Docker Desktop must be running)
npm install
cp .env.example .env      # then fill in the two secrets below
npm run db:migrate        # apply migrations
ALLOW_DESTRUCTIVE_SEED=1 npm run db:seed   # realistic demo data (truncates first)
npm run dev               # http://localhost:3000
```

Generate the two required secrets:

```bash
node -e "console.log('AUTH_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
node -e "console.log('PLATFORM_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64url'))"
```

### Demo data

`npm run db:seed` (development only: it truncates the target schema first) creates
demo organisations with one user for every role. Set `SUPERADMIN_PASSWORD` before
running it; the seed refuses to invent one. The demo sign-ins are printed at the end
of a local seed run and are deliberately not listed here. Never run the seed against
a production database.

A second organisation (`bright-retail`) is seeded on a trial with the optional
modules switched off, so the feature-flag behaviour is visible immediately.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build (runs `prisma generate` first) |
| `npm run test` | Vitest — the payroll, attendance, calendar and billing domain suites |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:seed` | Reset and reseed demo data |
| `npm run db:studio` | Prisma Studio |
| `npm run icons` | Regenerate the PWA icon set |
| `npm run face:models` | Download the face detection/recognition models (38 MB, once) |
| `npm run jobs` | Maintenance: selfie retention purge, orphan files, stale counters |

---

## Architecture

```
src/
  domain/      PURE business logic — no Next, no Prisma, no framework. Unit-tested.
    money.ts     integer paise; every rounding decision funnels through here
    date.ts      calendar dates as "YYYY-MM-DD" strings, never Date
    calendar/    week-off patterns (fixed / multiple / rotational / custom), holidays
    attendance/  geofence maths, day evaluation (late, half day, extra day, overtime)
    payroll/     policy schema, the staged engine, simulator, full & final settlement
    billing/     seat pricing, coupons, the payment state machine
  lib/         platform plumbing — auth, RBAC, tenancy, crypto, storage, audit, errors
  services/    orchestration: domain + Prisma + audit, always taking an AuthContext
  components/  UI primitives and the app shell
  app/         routes only — no business logic
```

Three rules hold the design together:

1. **`src/domain` imports nothing from `next`, `@prisma/client` or `src/lib`.** It is
   pure TypeScript, which is why 150 tests run in under two seconds and why the
   simulator, the seed script and production payroll share one calculation.
2. **Every service takes `ctx: AuthContext` first** and applies the tenant filter
   itself. The organisation id comes from the session, never from a request body.
3. **UI hiding is never the security boundary.** Every route handler repeats the
   permission check the sidebar used.

Design documents live in [`docs/`](docs/): architecture, the permission matrix, the
payroll engine, the payment state machine and the module map.

---

## Payroll

Payroll is a versioned rule document, not a formula in code. `PayrollPolicy` covers
salary components, the payable-day basis, attendance penalties, overtime, extra-day
treatment, leave pay, advances, training pay, statutory deductions and rounding — and
the pipeline stages themselves can be reordered or disabled.

Every amount carries a trace line:

```
RESOLVE_SALARY    Effective monthly CTC        ₹2,50,000   sum of weighted segments
PAYABLE_DAYS      Per-day rate                  ₹8,064.52  25000000 ÷ 31 days
PRORATE_EARNINGS  Basic Salary               ₹1,08,870.97  50% of CTC → 12500000 × 27/31
ABSENCE           Absent days                 -₹16,129.04  2 days excluded at 806452/day
LATE_DEDUCTION    Late arrivals               -₹12,096.78  floor((12−2)/3) = 3 half-days
OVERTIME_CREDIT   Overtime                     ₹14,541.41  9.62 h × 100807/h × 1.5
ADVANCE_RECOVERY  Salary advance recovery         -₹5,000  2000000 ÷ 4 instalments
RESULT            Net payable                 ₹2,15,187
```

**Double counting is designed out.** Day-based pay has exactly one mechanism —
proration by payable days. Absences, unpaid leave and the unpaid half of a half-day are
simply missing from the numerator, so the natural per-day loss happens automatically;
the deduction stages only add penalties *beyond* that.

A locked payroll run stores its policy snapshot, so changing settings later never
rewrites history. Unlocking creates a new revision rather than mutating the old one.

---

## Attendance & face verification

Marking attendance verifies three things, all on the server:

1. **Where** — the browser sends coordinates; the distance to the configured
   work location is computed here and checked against its radius (150 m by default).
   The reading's accuracy is recorded with every mark and shown beside it; refusing
   a coarse reading outright is a per-organisation switch, off by default, because
   the phones it turned away were old rather than far.
2. **Who** — the selfie is matched against a reference photo enrolled on the
   employee's profile.
3. **When** — the timestamp is the server's clock, so a phone with its date
   wound back cannot backdate a punch.

Face matching runs **entirely on this machine**, using two ONNX models from the
OpenCV Zoo: YuNet for detection and landmarks, SFace for a 128-dimension
descriptor. No image and no descriptor ever leaves the server. Download them once:

```bash
npm run face:models
```

The browser uploads pixels and nothing else. It never sends a descriptor and
never sends a verdict — a client that could assert "this matched" would make the
whole feature decorative.

Three modes, set per organisation:

| Mode | Behaviour |
|---|---|
| `OFF` | Selfie stored, no comparison |
| `ADVISORY` *(default)* | Compared and recorded; a mismatch is flagged for HR but does not block |
| `REQUIRED` | A mismatch refuses the check-in |

`ADVISORY` is the default deliberately. Bad light, a mask, a new beard and a
cheap front camera all lower the score, so an organisation should watch the
flags for a while before letting the system turn people away. Two things never
block regardless of mode: an engine outage, and a missing enrolment when policy
says to allow it — neither is the employee's fault.

A refused attempt is still recorded, with its photo and score, but is **not**
attached to an attendance day. Repeated failures are exactly the signal HR needs,
whether they mean a stale reference photo or somebody trying it on.

**On the biometric data.** The descriptor is encrypted at rest with
`PLATFORM_ENCRYPTION_KEY`, is never returned by any API, never appears in an
audit row, and is deleted along with the photo when the enrolment is removed. A
consent timestamp is recorded when an employee enrols themselves.

---

## Files & images

Every image is **re-encoded before it is stored** — never written as uploaded.
A phone selfie arrives at 3–6 MB and lands at roughly 40–80 KB:

| Profile | Max edge | Typical result |
|---|---|---|
| Attendance selfie | 800 px | ~40 KB (95 % smaller) |
| Face reference photo | 1024 px | ~100 KB (87 % smaller) |
| Scanned document | 2000 px | ~230 KB (70 % smaller) |
| Logo / signature | 512 px | PNG, transparency preserved |

Re-encoding also **strips EXIF**, which removes the GPS coordinates, device
serial and original timestamp that phones embed inside photos. Attendance records
location deliberately and with consent; a second invisible copy inside the image
is not something anyone agreed to. PDFs pass through untouched — re-encoding one
would destroy its text.

Files are stored **in Postgres** by default (`STORAGE_DRIVER=database`), so one
backup covers the data and its files, and nothing is lost on a host with an
ephemeral filesystem. With compression the volume is modest; if it ever stops
being so, `STORAGE_DRIVER=local` writes to disk today and an S3 driver slots into
the same `StorageAdapter` interface without touching a service.

Uploads are refused unless their **bytes** match a known image or PDF signature —
an allowed extension and a plausible `Content-Type` are not enough, or anything
could get in simply by being named `.jpg`.

### Selfie retention

Attendance selfies are deleted after **60 days** (configurable in platform
settings). What survives is the *record*, not the image: timestamp, location,
distance and face-match score all remain, so historical attendance and payroll
stay fully auditable. Only the pixels go.

```bash
npm run jobs      # purge expired selfies, orphan files and stale rate-limit rows
```

The job is idempotent and resumable — run it from cron, a platform scheduler, or
by hand.

---

## Security

- bcrypt password hashing (cost 12), signed JWT in an httpOnly cookie, backed by a
  revocable `Session` row so "sign out everywhere" genuinely works.
- Failed logins are indistinguishable from missing accounts, including response
  timing — a bcrypt comparison is burned against a dummy hash when no user matches.
- Per-IP and per-email rate limiting, plus account lockout.
- AES-256-GCM field encryption for PAN, Aadhaar, bank details, organisation API keys,
  TOTP secrets and issued payment codes.
- Cross-tenant reads return **404, not 403** — confirming an id exists but belongs to
  someone else is itself a leak.
- Audit rows redact secrets automatically and never block the operation they describe.
- The service worker never caches API responses, and attendance is never queued
  offline: a queued punch would let the device choose its own timestamp.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. In production it names a schema of its own. |
| `AUTH_SECRET` | Signs session tokens. 32+ random characters. |
| `PLATFORM_ENCRYPTION_KEY` | 32-byte base64url key for field encryption. **Losing it loses the data it protects.** |
| `SESSION_IDLE_DAYS` | Days a person stays signed in from their last use (default 30, sliding). `SESSION_MAX_AGE_SECONDS` is no longer read. |
| `APP_URL` | The origin this is served from. Used for metadata and the OpenRouter referer. |
| `STORAGE_DRIVER` | `database` (default), `supabase`, or `local` |
| `STORAGE_LOCAL_DIR` | Where the `local` driver writes |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` | Read only when the driver is `supabase` |
| `FACE_MODEL_DIR` | Where the ONNX models live (default `./models`) |
| `FACE_MATCHING` | Set to `off` to disable face verification platform-wide |
| `OPENROUTER_API_KEY` | Platform-default AI key; organisations may supply their own |
| `JOBS_SECRET` | Bearer token for `POST /api/jobs/run`. Unset means the endpoint is off. |
| `ALLOW_DESTRUCTIVE_SEED` | `1` lets `db:seed` truncate and reseed. Never set in production. |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | Bootstrap account for `db:seed` |

Never expose `PLATFORM_ENCRYPTION_KEY`, `AUTH_SECRET` or any OpenRouter key to the
browser. Nothing in `src/app` sends them client-side.

---

## Billing & seats

₹59 per **active employee** per month. Someone who has resigned, been terminated or
gone inactive does not consume a seat, so the bill tracks the payroll, not the
employee table. The price, the UPI id and the confirmation window live in
`PlatformSetting` — there is no price literal anywhere in the code.

The payment handshake supports both directions, switchable by the platform owner:

* **Reference** — the organisation pays by UPI and submits its own UTR, which the
  owner verifies and approves.
* **Issued code** — the owner verifies the payment and issues a six-digit code,
  which the organisation types in.

Either way a request is live for **four hours**. That window is checked when the
page loads *and again when anyone acts*, so a stale tab cannot approve an expired
request. Approving twice is a no-op rather than a double credit, and seats,
subscription history and coupon redemption all move in one transaction.

Running out of seats **blocks** activating another employee rather than quietly
billing for it later, with an "Add seats" route straight into the payment flow.

## Hosted or self-hosted

| | Self-host (this repo) | Managed at [hrms.broadmate.org](https://hrms.broadmate.org) |
|---|---|---|
| Cost | Free (AGPL-3.0) — you pay for your own server | Per-seat subscription |
| Setup, upgrades, backups, monitoring | You | Broadmate Global |
| Support | Community (GitHub issues) | Direct — `support@broadmate.org` |
| Your data | On your infrastructure | Hosted by Broadmate Global |

To buy the managed service, or to ask for help self-hosting, write to
**support@broadmate.org** or visit **[broadmate.org](https://broadmate.org)**.

## Status

Everything in the module map is built and reachable: authentication with TOTP
two-factor and a session manager, tenancy with per-organisation entry URLs,
billing and payments, self-signup on a trial, employees with logins and bulk
import, attendance with GPS and on-server face matching, an office kiosk, leave,
the payroll engine with its rule simulator and AI-assisted setup, salary slips,
documents, letters with an editable framework per type, announcements,
notifications, reports, reimbursements, onboarding, assets, performance, exit
and full-and-final settlement, encrypted data export, and support impersonation.

The domain layer is covered by unit tests (`npm run test`), the type checker is
strict, and `npm run verify` runs types, tests and a real production build.

### Before you run this with real people's data

* **Set up backups and rehearse a restore.** `docs/06-operations.md` has a nightly
  dump and the restore drill.
* **Escrow `PLATFORM_ENCRYPTION_KEY`.** It encrypts PAN, Aadhaar, bank details and
  TOTP secrets. Lose it and that data is gone; there is no recovery path.
* **Replace the legal pages.** `src/app/legal/*` (terms, privacy, refunds) and
  `src/lib/legal.ts` describe *Broadmate Global's* hosted service. If you host it
  yourself, you are the Data Fiduciary — have them rewritten for your organisation.
* **Replace the branding and contact details** in `src/lib/brand.ts`.
* **Do not seed production.** `db:seed` truncates every table and creates demo
  accounts with published passwords.

### Known gaps

Honest ones, being worked through rather than hidden:

* **No log drain.** Logs live in the container and are lost on redeploy.
* **Nothing notices if the nightly maintenance job stops running** unless you point
  an uptime check at `/api/health?deep=1` (see the operations doc).
* **No screens for salary structure or leave balances.** `salary.structure.manage`,
  `employee.salary.manage` and `leave.balance.manage` are granted and gate
  nothing; `carryForwardAmount` is tested and called by nothing. Per-employee
  salary profiles are readable everywhere and writable only by the seed.
* **`UserPermissionGrant`** is read by `context.ts` and written by nothing, so a
  role cannot be adjusted for one person.
* **`src/services/` has little test coverage.** The domain layer is well covered;
  the service layer is not.
* **Tenant isolation is enforced in the application, not by Postgres RLS.** It
  holds and is swept, but it is one missing `where` clause from not holding.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md). Found a vulnerability? Please do **not**
open a public issue — see [SECURITY.md](SECURITY.md).

## License

[GNU AGPL v3](LICENSE). If you modify Meridian HRMS and offer it to others over a
network, the AGPL requires you to make your modified source available to them.
For a commercial license or a managed deployment, contact **support@broadmate.org**.

---

Built by **[Broadmate Global](https://broadmate.org)**.
