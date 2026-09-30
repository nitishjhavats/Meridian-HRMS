# Roles & Permission Matrix

## Hierarchy
```
SUPERADMIN  (platform, organizationId = null)
   └── ORG_OWNER
         └── ADMIN
               └── HR_MANAGER
                     └── MANAGER
                           └── TEAM_LEAD
                                 ├── SUPERVISOR
                                 └── TEAM_MEMBER

SUPERVISOR — ranks between TEAM_LEAD and TEAM_MEMBER (6), and inherits nothing
             from TEAM_LEAD. Its set is TEAM_MEMBER's plus two. See below.
KIOSK      — off the tree entirely. A shared screen, not a person. Rank 99.
```

From `TEAM_MEMBER` up to `ORG_OWNER` the sets are **cumulative**: each tier is
the one below it plus additions. That is why `MANAGER` adds only permissions
`HR_MANAGER` already had — anything new at a middle tier silently widens every
tier above it. `permissions.test.ts` asserts exactly that, and asserts that the
hand-written `SystemRole` union still matches Prisma's generated enum: they are
not linked, and a role in one and not the other produces an *empty* permission
set rather than a compile error. The chain that test walks is `TEAM_MEMBER` →
`TEAM_LEAD` → `MANAGER` → `HR_MANAGER` → `ADMIN` → `ORG_OWNER`. `SUPERVISOR`,
`SUPERADMIN` and `KIOSK` sit outside it, because none of the three is built on
the tier below.

Enum **declaration order is seniority**, and `findApprover` reads it. `MANAGER`
was added with `ALTER TYPE ... ADD VALUE 'MANAGER' AFTER 'HR_MANAGER'` for that
reason; a bare `ADD VALUE` appends, which would have sorted it below an office
device.

**MANAGER = TEAM_LEAD + `employee.state.change` + `attendance.override`.**
Confirming their own people off probation, and correcting their own team's
attendance — the two things that otherwise force an escalation to HR for
something about their own team. Both writes are scoped through
`visibleEmployeeIds`, which matters: attendance decides payable days, which is
pay.

## The supervisor (`SUPERVISOR`)

**SUPERVISOR = TEAM_MEMBER + `attendance.override` + `attendance.read.team`**,
and nothing else. It is a branch off Team Member rather than a tier: `TEAM_LEAD`
holds neither of those two, so a supervisor is not a junior team lead and a team
lead is not a supervisor.

It exists for one job — the bypass panel on the office device. Somebody's face
will not scan at seven in the morning, and the person actually standing there is
the receptionist or the shift in-charge. `supervisorOverride` reads the
credentials typed into that panel, resolves **that person's** permissions and
their own place in the reporting graph rather than the device's, which has
neither, and lets the mark through if they hold `attendance.override` — and
otherwise only for somebody who genuinely reports to them. The day is recorded as
unverified with the authoriser named.

Before the role existed, the only ways to do that job were `MANAGER`, which also
confirms people off probation and corrects a whole team's attendance, or a
hand-granted `attendance.override` an administrator had to know to look for. Both
hand out far more than the job needs, and the second is invisible until somebody
audits the grant table.

Its rank is **6**, below `TEAM_LEAD`: authorising one thing at a device must not
outrank approving leave for a team. `attendance.read.team` comes with the
override only so that a supervisor can see the day they just vouched for —
`overrideDay` scopes every write through `visibleEmployeeIds`, so holding it is
not the organisation's attendance. It is offered in the employee login-role
picker (`EMPLOYEE_LOGIN_ROLES`), which is the one list every screen and route
reads from.

Role is a coarse bucket. Actual authorisation is by **permission string**
(`resource.action[.scope]`). A role maps to a default permission set; an org may grant
extra permissions to an individual user (`UserPermissionGrant`) — e.g. an Accountant
designation that also gets `payroll.disburse`.

Scopes: `.all` (whole org) · `.team` (users reporting to me, transitively) · `.self`.

## The office device (`KIOSK`)

The ninth `SystemRole`, and the only one that is not a person: a shared screen
in a reception or on a shop floor that marks attendance for whoever is standing
in front of it. `ROLE_LABELS` calls it "Office device".

It sits **off** the hierarchy rather than under `TEAM_MEMBER`, and its set is not
built from Team Member's the way every other tier is built from the one below.
`KIOSK_PERMISSIONS` is written out in full, and it is two entries long:

| Permission | What it allows |
|---|---|
| `attendance.kiosk.operate` | Show the shared check-in screen, and the roster on it. |
| `attendance.mark.kiosk` | Record a check-in for a named employee at that screen. |

Two permissions rather than one, so that the roster a device may read and the act
of marking on somebody's behalf stay separate grants. No other role holds either
of them.

What is absent matters more than what is present. There is no
`attendance.mark.self` — a device has no attendance of its own, only other
people's. There is no `payroll.read.self`, no `document.read.self`, not even
`notification.read`. Had this been a flag on Team Member instead of a role it
would have inherited all of those, which is the argument for making it a role:
every `Record<SystemRole, …>` in `permissions.ts` refuses to compile until the
device case is answered deliberately. `resolveScope` returns `null` for every
family, because the device reads nothing.

Its rank is **99**, below every person rather than beside one, so `canManageRole`
lets an administrator manage a device and lets a device manage nobody.

**A kiosk takes no per-user grant.** `effectivePermissions` returns the role set
and stops, before it looks at the grant rows at all — in both directions. A grant
cannot add `payroll.read.all` to a device, and a revocation cannot take
`attendance.mark.kiosk` away from one. The reason is where the account lives, not
what it does: an unattended screen in a room the public walks through must not be
grantable into anything, and the case for it being safe is exactly that its
permission set is exhaustive and fixed. A per-user grant is the one mechanism
that would quietly widen it, on the account least likely to be watched. The
permissions screen refuses the edit and says so rather than saving a row
`effectivePermissions` would ignore.

Two consequences follow from the same argument. A kiosk is not created from the
employee form — the login-role picker offers Team Member, Supervisor, Team Lead,
Manager, HR and Admin, and nothing else — but by `createKioskDevice`, which needs
`attendance.settings.manage` and mints a user with no `Employee` record, so a
device costs no seat. And its session lasts thirty days rather than the twelve
hours a person gets by default, since nobody is there to sign it back in each
morning — the exposure is bounded by the two permissions above rather than by the
clock, and revoking the session still takes effect immediately.

A third used to follow and no longer does: **a Superadmin may sign in as a
device.** The refusal was right about the risk and wrong about the remedy —
borrowing a device's identity to *mark attendance* is exactly the fraud the face
check exists to stop, but "why does the reception screen show nobody" is a real
support question, and answering it meant asking somebody in that office to
describe their screen down a phone. So it is allowed and forced read-only
whatever the caller asks for, and a read-only session cannot write, which means
it cannot mark attendance. It lands on `/kiosk` rather than a sign-in page.

### A device is not in People

A kiosk has no `Employee` row and the organisation's People list is built from
employees, so it does not appear at `/employees` — and it is not going to. A
device has no joining date, no designation, no reporting line, no salary and no
attendance of its own, so most of what that screen offers a row would mean
nothing on this one. Inventing an `Employee` record to make it list would put a
tablet everywhere employees are counted — seats, headcount, the payroll register
— unless every one of those places learned to special-case it, which is a lot of
code to write in order to make a device look like staff. The absent row is not
the omission.

It is managed where it is a device: **Settings → Attendance rules → office
devices**, which lists each one with its work location and when it was last seen,
and offers the two things anybody actually does to a device — revoke it, or give
it a new password. From the platform console it *does* appear, in the People card
under "Accounts with no employee record", which is where a Superadmin signs in as
one.

## Permission catalogue (excerpt — full list in `lib/auth/permissions.ts`)

| Permission | SUPER | OWNER | ADMIN | HR | MGR | LEAD | SUPV⁴ | MEMBER | KIOSK³ |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| platform.org.create / suspend | ✔ | | | | | | | | |
| platform.payment.approve | ✔ | | | | | | | | |
| platform.coupon.manage | ✔ | | | | | | | | |
| platform.passwordreset.release | ✔ | | | | | | | | |
| platform.analytics.read | ✔ | | | | | | | | |
| org.settings.read | | ✔ | ✔ | ✔ | | | | | |
| org.settings.write | | ✔ | ✔ | | | | | | |
| org.billing.manage | | ✔ | ✔ | | | | | | |
| employee.read.all | | ✔ | ✔ | ✔ | | | | | |
| employee.read.team | | | | | ✔ | ✔ | | | |
| employee.read.self | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| employee.create / update | | ✔ | ✔ | ✔ | | | | | |
| employee.terminate | | ✔ | ✔ | | | | | | |
| attendance.mark.self | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| attendance.read.all | | ✔ | ✔ | ✔ | | | | | |
| attendance.read.team | | | | | ✔ | ✔ | ✔ | | |
| attendance.override | | ✔ | ✔ | ✔ | ✔ | | ✔ | | |
| attendance.pin.issue⁵ | | ✔ | ✔ | | | | | | |
| attendance.kiosk.operate | | | | | | | | | ✔ |
| attendance.mark.kiosk | | | | | | | | | ✔ |
| leave.request | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| leave.approve.team | | | | | ✔ | ✔ | | | |
| leave.approve.all | | ✔ | ✔ | ✔ | | | | | |
| leave.type.manage | | ✔ | ✔ | ✔ | | | | | | <!-- gated nothing until round 7; /settings/leave-types is the screen -->
| payroll.run | | ✔ | ✔ | | | | | | |
| payroll.read.all | | ✔ | ✔ | ✔ | | | | | |
| payroll.read.self | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| payroll.finalize / lock | | ✔ | ✔ | | | | | | |
| payroll.unlock | | ✔ | | | | | | | |
| payroll.rules.manage | | ✔ | ✔ | | | | | | |
| payroll.disburse | | ✔ | ✔ | | | | | | |
| salary.structure.manage | | ✔ | ✔ | | | | | | |
| advance.manage | | ✔ | ✔ | | | | | | |
| document.upload.self | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| document.read.all | | ✔ | ✔ | ✔ | | | | | |
| document.delete.approve | | ✔ | ✔ | ✔ | | | | | |
| letter.template.manage | | ✔ | ✔ | ✔ | | | | | |
| letter.issue | | ✔ | ✔ | ✔ | | | | | |
| letter.read.self | | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| announcement.create | | ✔ | ✔ | ✔ | ✔¹ | ✔¹ | | | |
| announcement.moderate | | ✔ | ✔ | ✔ | | | | | |
| ai.config.manage | | ✔ | ✔ | | | | | | |
| audit.read | ✔ | ✔ | ✔ | | | | | | |
| notification.read | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| report.export | ✔ | ✔ | ✔ | ✔ | ✔² | ✔² | | | |

Three cells in the SUPER column were wrong until they were checked against
`ROLE_PERMISSIONS.SUPERADMIN` rather than against what a platform owner sounds
like they should have: `org.settings.read` had a tick and is not in the set — a
platform owner reads an organisation's settings by impersonating, not by right —
while `report.export` and `notification.read` are in the set and had none. The
lesson is the same one the cumulative-inheritance note above makes: this table
is a copy of the code and drifts unless it is derived from it.

¹ Team Lead may create announcements targeted at their own team only.
² Team Lead exports are forced to `scope=team`.
³ `KIOSK` is not a tier with most of its row missing: those two ticks are its
  entire set, and it takes no per-user grant in either direction. See above.
⁴ `SUPERVISOR` is Team Member's row plus two attendance ticks, not Team Lead's
  with cells taken out: a team lead has `attendance.read.team` and not
  `attendance.override`, and a supervisor has both and nothing else of Lead's.

⁵ `attendance.pin.issue` is the one permission behind the Attendance PIN tab,
  the PIN desk, the profile widget and `issueAttendancePin`. Owner and Admin
  hold it from the bundle. Everybody else gets it from a row on the PIN
  authority screen (Settings → Attendance) — by **role** (one switch per login
  role), by **designation**, or by **person** — which `loadContext` folds into
  the permission set once per request, so navigation and page guards can read
  it synchronously. An explicit "take away" on the person wins over a row.
  `attendance.override` no longer implies it: correcting a day after the fact
  and waving somebody past the camera are different powers. A reporting manager
  can still issue for their own reportees; nobody, Owner included, can issue for
  themselves. Never `KIOSK`.

## Enforcement
`requirePermission(ctx, "payroll.finalize")` throws `ForbiddenError`.
`resolveScope(ctx, "attendance.read")` returns `"all" | "team" | "self"` and the service
builds the `where` clause from it — the client never sends a scope.
UI hiding is cosmetic only; every route handler repeats the check.

## Admin forgot-password flow (Superadmin-released OTP)
1. Admin submits email on `/forgot-password`.
2. Server always answers "if the account exists, a request has been raised" (no enumeration).
3. If the account exists **and** role ∈ {ORG_OWNER, ADMIN}, create
   `PasswordResetRequest { userId, otpHash (bcrypt), expiresAt = now+15m, status=PENDING }`.
   The plaintext OTP is generated, shown **only** in the Superadmin console via a
   short-lived server-side cache entry (`otpPlaintext` kept in a `ReleaseToken` row
   encrypted with `PLATFORM_ENCRYPTION_KEY`, deleted on release/expiry). It is never
   returned to the requester.
4. Superadmin sees the request, clicks **Release OTP** → sees the code once, and
   communicates it out-of-band. Status → `RELEASED`.
5. Admin enters the OTP; server compares with `otpHash`, enforces one-time use
   (`consumedAt`), 5-attempt lockout, and expiry. Then password is reset.
6. Superadmin may also **Reject** a request. Every step is audit-logged.
Non-admin roles use the ordinary reset path (token emailed once transport exists);
until then HR/Admin resets their password from the employee screen.
