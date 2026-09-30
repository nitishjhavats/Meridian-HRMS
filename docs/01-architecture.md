# HRMS + Payroll PWA — Architecture

## 1. Product summary
Multi-tenant SaaS HRMS. One deployment serves many **organisations**. A platform
**Superadmin** owns the system; each organisation runs HR, attendance, leave,
payroll, documents, letters and announcements under **its own configurable rules**,
without touching source code.

## 2. Stack (chosen, and why)

| Layer | Choice | Reason |
|---|---|---|
| App | Next.js 15 (App Router) + React 19 + TypeScript strict | one deployable unit, server actions + route handlers, RSC keeps sensitive data server-side |
| UI | Tailwind CSS v4 + hand-rolled shadcn-style primitives on Radix | no CLI/network dependency, full control, tiny bundle |
| DB | PostgreSQL + Prisma ORM | relational integrity for payroll; migrations; typed client |
| Auth | Custom session auth: bcrypt password hash + signed JWT in httpOnly cookie (`jose`) | no vendor lock; role+tenant claims verified server-side each request |
| Storage | `StorageAdapter` interface, local-disk driver now, S3/Supabase driver later | requirement: no Supabase yet |
| PDF | `@react-pdf/renderer` (server) | pure JS, no headless Chrome |
| Charts | Recharts | |
| AI | OpenRouter, default model `glm-5.3-flash` | key never reaches the browser |
| PWA | hand-written `manifest.webmanifest` + `sw.js` + install-prompt hook | no build plugin lock-in |
| Tests | Vitest | payroll domain is pure TS, fast to test |

Deliberately deferred (per instruction): Supabase, hosting/deploy, email/WhatsApp/push
transport. Notification *records* + dispatcher interface are built now so a transport
can be plugged in later.

## 3. Layering rule

```
app/            Next.js routes (RSC pages + route handlers)  -- no business logic
  (auth)/       login, forgot-password
  (super)/      superadmin console
  (org)/        organisation app (owner/admin/hr/lead/member)
  api/          route handlers
components/     presentational + shared UI
lib/
  auth/         session, password, guards
  db/           prisma client
  storage/      StorageAdapter
  ai/           OpenRouter client, rule-schema validators
  pdf/          documents
domain/         PURE, framework-free business logic (unit-tested)
  payroll/      rule engine, pipeline, explainer
  attendance/   status resolution, late/half-day/overtime
  calendar/     weekly-off rotation, holidays, working days
  leave/        accrual, balance
  billing/      pricing, coupon, payment state machine
services/       orchestration: domain + prisma + audit + notifications
  (every mutation goes through a service; services take an AuthContext)
```

**Hard rules**
1. `domain/` imports nothing from `next`, `@prisma/client`, or `lib/`. Pure functions.
2. Every service function's first argument is `ctx: AuthContext` (userId, orgId, role,
   permissions). Tenant filter is applied inside the service, never by the caller.
3. Route handlers do: parse → zod validate → `requirePermission` → call service → map errors.
4. No business calculation is duplicated in the client. The client displays what the
   server computed (payroll breakdown is returned as data, not recomputed).

## 4. Tenant isolation (defence in depth)

> **This section described a design, and two parts of it were never built.** Corrected
> below to what the code does. `lib/db/tenant.ts` does not exist and there is no RLS
> migration; isolation is enforced in the services, by hand, on every query.

1. **Session claim** — the JWT carries `org`, and it is never read from the request body
   or query. `loadContext` additionally re-checks the claim against the database and
   refuses when they disagree (`src/lib/auth/context.ts`) — which is where a forged or
   stale tenant claim stops.
2. **Explicit scoping in every service** — each query carries
   `where: { organizationId: ctx.organizationId }`. There is **no** repository wrapper and
   no lint rule enforcing it: it is a convention held by review and by the route sweep.
   That is the honest description, and it is why a missing `organizationId` in a `where`
   clause is the single worst bug this codebase can produce.
3. **Row check on write** — `assertSameTenant` re-reads the row before update or delete
   and throws **`NotFoundError`**, not `ForbiddenError`. A 403 confirms that somebody
   else's row exists; a 404 does not.
4. **No Postgres RLS.** It was designed and never implemented. The application layer is
   the only boundary. Worth knowing before anybody describes this as "isolated at the
   database level" — it is not, and the marketing copy is careful to say "separate".

Superadmin has `organizationId = null` and a distinct route tree. It **can** act as an
org user — see `src/lib/auth/impersonation.ts` — for thirty minutes, with a stated
reason, and with every resulting audit row naming both the account acted as and the
superadmin who did it. That is a deliberate change from the original design, which had
support as read-only.

## 5. Configuration versioning
Organisation rules change over time. `OrgPolicyVersion` stores an immutable JSON
snapshot of {attendance, weeklyOff, leave, payroll, training, extraDay, rounding}
with `effectiveFrom`. Payroll for a period resolves the version effective on the
period start. A finalised `PayrollRun` additionally stores `policySnapshot` inline,
so historical payroll never changes when settings change later.

## 6. Error model
`AppError { code, httpStatus, message, details? }` with subclasses
`ValidationError(422) | UnauthorizedError(401) | ForbiddenError(403) | NotFoundError(404) |
ConflictError(409) | RateLimitError(429) | ExternalServiceError(502)`.
`lib/http/handler.ts` wraps every route: unknown errors are logged with a correlation id
and returned as `{ code: "INTERNAL", correlationId }` — never a stack trace.
