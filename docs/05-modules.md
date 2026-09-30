# Module map & build order

Each module ships: Prisma models → domain rules (if any) → service → API routes →
permissions → screens → tests.

| # | Module | Key screens |
|---|---|---|
| 0 | Platform core: auth, session, RBAC, tenancy, audit, errors, PWA shell | login, forgot-password |
| 1 | Superadmin console | orgs, org detail, payment queue, payment codes, coupons, reset requests, analytics, platform settings |
| 2 | Org onboarding & billing | plan/seat selector, UPI payment, coupon, confirmation code, order status |
| 3 | Org structure | departments, designations, reporting graph (matrix-capable) |
| 4 | Employees | list, profile (personal/employment/bank/salary), onboarding wizard, training plan, state transitions |
| 5 | Calendar | shifts, weekly-off (fixed/multiple/rotational), holidays |
| 6 | Attendance | GPS+selfie check-in/out, day ledger, review queue, PIN desk (`/attendance/pin`, gated on `attendance.pin.issue`), admin override, regularisation |
| 7 | Leave | types, allocation/accrual, requests, approval chain, balances, comp-off, on-demand week off (a capped-per-month type; the paid week-off quota is person → designation → payroll rule, see `03-payroll-engine.md`) |
| 8 | Salary structure | components, % distribution validator, per-employee salary profile + revisions |
| 9 | Payroll | policy editor, AI setup, simulator, monthly run, items, adjustments, lock, slips |
| 10 | Disbursement | payments against a run, partial/full, outstanding, advances + recovery |
| 11 | Documents | vault, upload, versions, deletion-request approval |
| 12 | Letters | templates + placeholders, AI draft, edit, issue, PDF |
| 13 | Announcements | feed, targeting, scheduling, likes, comments, moderation |
| 14 | Notifications | in-app centre + dispatcher interface |
| 14a | Chat | one-to-one messages, never deletable, 30-day purge, 50/day, block, report, admin export with a reason. Ships **on**, like everything else — see the registry |
| 15 | Reports | employee/attendance/leave/payroll/payment/advance/overtime + CSV/PDF |
| 16 | Settings | org, attendance, weekly-off, holiday, leave, payroll, training, letters, AI, security |

The table above is a **build order**, not the flag registry. Two things it does
not say, and one it could be misread as saying:

* Row 4's "onboarding wizard" is the form that *creates an employee*. It is not
  the `onboarding` module, which is joining checklists and task assignment for
  somebody who has already been created. They are different features with
  different switches; only the second one is a `ModuleKey`.
* Six modules have no row of their own here: `exit`, `reimbursements`,
  `onboarding`, `assets`, `recognition` and `performance`. All six are in the
  registry below.
* `ai` is the odd one out. It has no build-order row either, but it is not
  absent from the table — it appears inside three other rows, as "AI setup"
  (9), "AI draft" (12) and "AI" (16), because it is a capability those screens
  reach for rather than a place anybody navigates to. That is also why turning
  it off dims parts of the payroll and letters screens rather than hiding
  anything.

## Module registry

Fifteen `ModuleKey`s. **`src/lib/features.ts` is the source of truth** for every
column here; this table is a copy of it, in the order the modules are declared.

| Key | Module | What it is | Core | Granted | On | Requires |
|---|---|---|:-:|:-:|:-:|---|
| `attendance` | Attendance | GPS and selfie check-in, day statuses, regularisation, overrides | ✔ | ✔ | ✔ | — |
| `leave` | Leave | Leave types, balances, accrual, approval by reporting line | ✔ | ✔ | ✔ | — |
| `payroll` | Payroll & Salary | Salary structures, rule engine, runs, slips, disbursement | ✔ | ✔ | ✔ | — |
| `documents` | Document Vault | Employee documents with versions and approval-gated deletion | | ✔ | ✔ | — |
| `letters` | Letters | Templates, AI drafting and PDF issuance of official letters | | ✔ | ✔ | — |
| `announcements` | Announcements | Company feed with targeting, likes and comments | | ✔ | ✔ | — |
| `reports` | Reports | Exportable attendance, leave, payroll and payment reports | | ✔ | ✔ | — |
| `exit` | Exit & Full-and-Final | Resignation, notice tracking, clearance checklist, final settlement | | ✔ | ✔ | `payroll` |
| `reimbursements` | Reimbursements | Expense claims with bills, approval, payout through payroll | | ✔ | ✔ | `payroll` |
| `onboarding` | Onboarding | Joining checklists and task assignment for new employees | | ✔ | ✔ | — |
| `assets` | Assets | Issue and return of laptops, phones and other company property | | ✔ | ✔ | — |
| `recognition` | Recognition | Employee of the Month: the parameters, the monthly result, win counts | | ✔ | ✔ | — |
| `chat` | Employee Chat | Direct messages. Text only, kept thirty days, never deletable | | ✔ | ✔ | — |
| `performance` | Performance | Goals, review cycles, self and manager appraisals | | ✔ | ✔ | — |
| `ai` | AI Assistance | OpenRouter-powered letter drafting and payroll rule generation | | ✔ | ✔ | — |

**Core** = cannot be switched off. **Granted** = `defaultGranted`, what a new
organisation is created with. **On** = `defaultEnabled`, whether it is switched on
once granted. Both columns are solid ticks today, which makes them look
decorative — they are not. The grant is a real per-organisation switch a
Superadmin can close, the enable is one the organisation's own Admin can close,
and these columns record the defaults rather than the ceiling.

**Every module ships on.** Seven of them shipped off — `exit`, `reimbursements`,
`onboarding`, `assets`, `recognition`, `chat` and `performance` — on the argument
that an organisation should opt in rather than find a new part of the product one
morning. What happened instead is that a new organisation could not see features
it was paying for until somebody found the modules screen and guessed which ones
existed. Chat was the visible one: the nav entry was written and the icon never
appeared beside Announcements, because the module behind it was off. Switching a
module *off* is the deliberate act now, which is the right way round, and it can
be done for the whole organisation, for a designation, or for one person.

**A changed default only reaches organisations that do not exist yet.**
Provisioning writes an `OrgModuleSetting` row for every module at creation, so
flipping `defaultEnabled` in code leaves every tenant already running exactly as
it was. `npm run modules:enable` moves the rows that are already out there — a
dry run until `--apply` — and it deliberately skips any row whose `updatedById`
is set: a null there means "this is how it was provisioned" and a name means
"somebody decided this", and overruling the second would be the script arguing
with the customer about their own product.

Their screens are `/exit`, `/reimbursements`, `/onboarding`, `/assets`,
`/recognition`, `/chat` and `/performance`. `ai` has no screen of its own; it is
configured at `/settings/ai`.

## Granted, enabled, live

Two levels decide what the *organisation* has, and a module is live for it only
when **both** say yes. Two more decide what one *person* sees; they come after,
they can only take away, and they are the section below.

| Level | Who | Permission | Stored in |
|---|---|---|---|
| 1 — grant | Superadmin, per organisation | `platform.feature.grant` | `FeatureGrant { featureKey, granted }` |
| 2 — enable | The organisation's own Admin | `org.modules.manage` | `OrgModuleSetting { moduleKey, enabled }` |

`resolveModules` reads both maps and answers for all fifteen in one pass; a key
missing from either table falls back to that module's default. `liveModules` is
the organisation's answer, and `AuthContext.modules` is that set after the two
narrowing layers below. `requireModule` throws `FeatureDisabledError` from the
same narrowed set the sidebar renders from — which is why what somebody can see
and what they can reach cannot drift apart: a module that disappears from one
person's navigation also 403s if they type its URL.

**Core modules cannot be switched off.** `resolveModules` forces both flags true
for `core: true` whatever the tables hold, and `setModules` refuses the toggle
outright ("… is part of the core product and cannot be switched off"). Attendance,
Leave and Payroll are the three: a product that cannot record a day or pay
anybody is not this product.

**The grant is a ceiling.** Enabling something the platform has not granted is
refused with a message rather than quietly ignored, so the settings screen can
tell the Admin who to ask. `toggleableModules` is what that screen renders:
granted, and not core.

### The dependency cascade

`requires` is resolved in a **second pass**, after every module's own two flags.
Switching Payroll off therefore takes Exit and Reimbursements down with it — both
declare `requires: ["payroll"]` — and each says so instead of just looking off:

```
blockedBy: "MISSING_DEPENDENCY", missingDependency: "payroll"
```

`blockedBy` is the reason the settings screen shows, and it is one of three:
`NOT_GRANTED` (the platform has not made it available), `DISABLED` (the
organisation switched it off), `MISSING_DEPENDENCY` (something it needs is not
live).

One thing to know before adding a `requires`: the second pass reads the same map
it is writing, so a chain (A needs B, B needs C) only cascades the whole way if
the dependency is declared **earlier** in `MODULES` than the module that needs it.
Today the question does not arise — both `requires` point straight at `payroll`,
which is declared third.

## Narrowing a module: a designation, or one person

Everything ships on, which is the right way round and is still not what an office
looks like: the shop floor does not need the reimbursements screen, and the one
supervisor who coordinates it does. Two layers sit under the organisation's
answer, both edited on the same `/settings/modules` screen and both needing
`org.modules.manage`.

| Layer | Row | What it says |
|---|---|---|
| Organisation | `OrgModuleSetting` | What the company uses. Resolved first, under the Superadmin's grant. |
| Designation | `DesignationModuleSetting { designationId, moduleKey, enabled }` | What this job needs. |
| Person | `UserModuleSetting { userId, moduleKey, enabled }` | The exception neither of the others describes. |

**The nearest answer wins**: person, then designation, then organisation. An
absent row means "ask the layer above", and there is deliberately no third value
meaning "same as above" — a row that only repeats its parent is a row somebody
has to keep in step by hand, and will not. So clearing an override is a delete
(`enabled: null` on the route), not a third state.

**A layer can only take away.** `scopedModules` walks the organisation's live set
and drops what a lower layer switched off, so a `true` at either layer cannot add
a module the platform has not granted or the company has switched off. What a
`true` *can* do is beat the layer between it and the organisation: one person
switched on stays on where their whole designation is off. Any other reading
would let an administrator hand somebody a module the company is not paying for.

Core modules are refused here exactly as they are above — `setScopedModule` will
not write a row for Attendance, Leave or Payroll.

Both sets of rows are read on **every request**. `lib/auth/context.ts` loads them
alongside the queries it already makes, which is affordable because a row only
exists where somebody deliberately changed something; the designation layer is
skipped entirely for a login with no employee behind it, or an employee with no
designation.

Office devices are not offered on that screen. A `KIOSK` holds two permissions
and reaches one page, so there is nothing about it to narrow.

## Attendance: a day's lifecycle

Row 6 above is one line; the day it records has a shape, and most of the
questions an owner asks are about one of its edges.

**A check-in writes `CHECKED_IN`.** That is the day's status for the hours
between arriving and leaving: lateness is already known and is recorded, the
worked time is not. It used to be scored at once as if the check-out had
already failed to come, so with the shipped missing-checkout rule every person
read *half day* from the moment they walked in, and one owner corrected those
rows by hand every evening. `CHECKED_IN` counts as present on the dashboard,
the grid and the month tile, and it is never final: payroll settles it before
it reaches a ledger, and an administrator cannot choose it as an override.

**A check-out scores the day.** Worked minutes, early leave, overtime and the
full/half/absent verdict are all computed from the pair, with the organisation's
attendance policy. A later check-out moves the last-out time rather than being
refused, because somebody who leaves at lunch and comes back leaves again in the
evening, and the evening one is the one the month's worked hours should read.

**A check-out within five minutes of the check-in is refused.** Measured three
times in four days on one organisation: check-outs 9, 9 and 51 seconds after the
check-in, each scoring the day absent with nothing worked. Nobody leaves nine
seconds after arriving; the button had turned into *Check out* and was pressed
again. The refusal says how long ago the check-in was and to check out when they
leave.

**A night shift keys to its shift day.** Rows are keyed by date, and the date
used to be the calendar date of the press: on a 22:00–06:00 shift the 06:00
check-out fell on the next date, found no check-in there, and was refused
*you have not checked in today* — every night, for everybody on nights.
`shiftDayFor` now resolves an early-morning moment that is still inside the
previous shift day's marking window to that day, on both the phone and the
office device, and the check-in screen shows that day too. The close settles
such a row on the same axis, so a 00:30 arrival on a 22:00 shift is 150
minutes late rather than 30 minutes into a day that had not started.

**A rejected check-out reopens the day.** Rejecting a flagged check-out from
the review queue clears the check-out and the worked minutes and puts the row
back to `CHECKED_IN`, with no override on it, so the person's real check-out
later — or the nightly close — settles the day as if the rejected punch had
never happened. It used to settle the day at once *and* stamp it overridden,
which froze that verdict against the check-out that followed. A rejected
check-in still takes the whole day back: on a working day it becomes absent,
on a week off or a holiday it becomes that rest day again, never an absence.

**The missing-checkout rule applies at the close of the day, not before.** A
day still `CHECKED_IN` when it closes becomes whatever the organisation chose
under *Missing check-out*: ignore (a full day), half day, or absent. Until then
the day is simply open. Payroll applies the same rule to any `CHECKED_IN` row it
meets, so a night the close missed is worth exactly what the close would have
made it, never an in-progress status the engine has no case for.

**The day closes itself.** The nightly maintenance run (`docs/06-operations.md`
§3) closes every date whose marking window has passed: a person on the roll
with no row on a working day gets an `ABSENT` row written by the system
(*No check-in recorded* — the grid used to show a blank there while payroll
already counted it absent), and every open `CHECKED_IN` row is settled as
above (*No check-out recorded*) — for everybody, including people since
resigned, because the open row is theirs. Leave, rest days, overridden rows and
anything already scored are left alone, and so are two blanks it counts rather
than fills: a working day an approved leave request covers with no row of its
own, and a working day for somebody who could not have marked by any path. A
system-written absence is an ordinary absent day: an administrator overrides
it, or the employee asks for a regularisation, exactly as before.

**The primary face is the person holding the phone.** The shop floor has other
people in it. The engine used to keep whichever detection had the highest
confidence, often a bystander's sharp, well-lit head at the back, and counted
every head as a face: on one organisation that was sixteen refusals for *several
faces* and four for *no match* in a week, all from people whose good marks score
0.73 or better. Now the largest face in the frame is the one matched, a head at
less than half its area is somebody behind and is ignored, and the primary is
anchored across the burst so a frame that briefly loses the employee yields
nothing rather than promoting the neighbour. Two faces of comparable size still
trip *several faces*, because that is two people at the camera.

**Refusing a coarse GPS reading is a switch, off by default.** The distance to
the fence is always measured and always decides. Whether a reading whose
reported accuracy is worse than a limit is refused before that measurement is
the organisation's choice under Settings → Attendance → *Require an accurate GPS
fix*; it used to be a constant with no switch, and the people it turned away
were at the counter with old phones. The accuracy is stored with every mark and
shown beside it, so a reviewer can see when a reading was rough without anybody
having been locked out over it.
