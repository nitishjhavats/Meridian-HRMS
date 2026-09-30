# Payroll Rule Engine

Payroll is **not** hard-coded formulas. It is a deterministic pipeline over a
versioned, org-owned `PayrollPolicy` JSON document. Every amount produced carries a
trace line explaining how it was derived.

## Core types (see `domain/payroll/types.ts`)

```ts
type Money = number;              // integer minor units (paise). No floats in money math.
type PayrollPolicy = {
  version: number;
  cycle: { type: "MONTHLY"; startDay: number };          // startDay 1 = calendar month
  payableDaysBasis: "CALENDAR_DAYS" | "FIXED_30" | "WORKING_DAYS" | "WORKING_DAYS_PLUS_PAID_OFF";
  components: SalaryComponent[];
  attendance: AttendanceDeductionPolicy;
  overtime: OvertimePolicy;
  extraDay: ExtraDayPolicy;
  leave: LeavePayPolicy;
  advance: AdvanceRecoveryPolicy;
  rounding: { mode: "NONE"|"NEAREST"|"UP"|"DOWN"; to: number };  // to = 100 → nearest rupee
  order: PipelineStage[];         // lets an org reorder/disable stages
};
```

### Salary components (§21 global distribution)
```ts
type SalaryComponent = {
  code: string; name: string;
  kind: "EARNING" | "DEDUCTION";
  calc:
    | { type: "PERCENT_OF_CTC"; percent: number }       // % of total monthly salary
    | { type: "PERCENT_OF_COMPONENT"; of: string; percent: number }
    | { type: "FIXED"; amount: Money }
    | { type: "BALANCE" };                              // absorbs the remainder
  prorated: boolean;                                    // reduced by payable-day ratio?
  taxable: boolean; showOnSlip: boolean; order: number;
};
```
Default seeded structure: `BASIC 100% / HRA 0% / ALLOWANCE 0% / BONUS 0% / OTHER 0%`.
Validation: percent-of-CTC components must total **exactly 100%** unless a `BALANCE`
component exists, in which case they must total **≤ 100%**. Mixed fixed + percent is
allowed: fixed components are subtracted from CTC first, percentages apply to the
remainder (`percentBase` is configurable: `CTC` or `CTC_MINUS_FIXED`).

### Attendance policy (§15, §13)
```ts
type AttendanceDeductionPolicy = {
  shift: { start: "09:00"; end: "18:00"; breakMinutes: 60 };
  graceMinutes: number;                 // 10 → 09:10 still on time
  lateAfterMinutes: number;             // 15 → marked LATE
  halfDayAfterMinutes: number;          // 30 → day becomes HALF_DAY
  earlyLeaveBeforeMinutes: number;
  minMinutesFullDay: number; minMinutesHalfDay: number;
  lateDeduction:
    | { type: "NONE" }
    | { type: "PER_OCCURRENCE"; freeCount: number; amount: Money }
    | { type: "HALF_DAY_PER_N"; n: number; freeCount: number }   // 3 lates = ½ day
    | { type: "PRORATA_MINUTES" };
  absentDeduction: { type: "PER_DAY_RATE" } | { type: "FIXED"; amount: Money };
  halfDayFactor: number;                // 0.5
};
```

### Extra day / off-day work (§18)
`{ mode: "NORMAL_DAY" | "MULTIPLIER"; multiplier: number } | { mode: "COMP_OFF" } |
 { mode: "OVERTIME_RATE" }` — org picks; comp-off credits a `LeaveBalance` instead of cash.

Editable on the payroll rules screen. It was not until round 7: the engine had
implemented every mode since it was written and only the AI rule builder could
set one, so "worked a week off, give them a day's overtime" was a rule the
product could calculate and no administrator could switch on.

### Week offs: three layers, three questions

"Week off" is three different numbers, and for a long time the product kept
them on three screens under one name. They answer three questions, and each
one has its own ladder:

| Layer | The question | Resolved | Where it is set |
|---|---|---|---|
| Rest days | *Which* weekdays does this person not work? | person → named pattern → organisation default → Sunday | profile Week off card → `/settings/calendar` |
| Paid quota | *How many* rest days a month is this person paid for? | person → designation → payroll rule → whatever the pattern gives | profile → `/settings/leave-balances` last column → `/payroll/rules` |
| On-demand week off | An *extra* rest day, asked for like leave | a `LeaveType` with `isWeekOff`, allocated per person, capped per month | `/settings/leave-types` and the balance grid |

In every ladder null means "ask the layer above", never zero. A person nobody
has set must not read as a person owed no rest days.

#### Rest days — which weekdays

`Employee.weeklyOffConfig` is the person's own answer, `{ type: "FIXED", days:
[n] }` or `{ type: "MULTIPLE", days: [n, m] }` with `0` = Sunday … `6` =
Saturday. It is consulted before the employee's named `WeeklyOffPattern`, which
comes before the organisation's `isDefault` pattern, which comes before
`DEFAULT_WEEKLY_OFF` (Sunday) — the constant now only reaches an organisation
that has no default pattern at all. One resolver, `resolveWeeklyOff` in
`services/org/weeklyOff.ts`, and every caller uses it: attendance `record.ts`,
leave `index.ts`, payroll `inputBuilder.ts` and `samplePayslip.ts`. It has to be
one function: before it was, "organisation default" gave three answers for the
same August — leave charged a Sunday that payroll then paid as a rest day.

What a rest day does:

* **Attendance** — a rest day with nothing recorded is `WEEK_OFF`, not
  `ABSENT`. Worked, it becomes `EXTRA_DAY` and the extra-day policy above
  decides what that is worth on top of the day itself.
* **Leave** — `countLeaveDays` removes rest days into `skipped` before anything
  is charged, so a leave that spans a Sunday neither spends a balance for it nor
  writes an attendance row on it, and a request made entirely of rest days is
  refused (`ZERO_DAYS`).
* **Payroll** — `countDays` puts `WEEK_OFF` and `DAY_OFF` into `weekOffDays`,
  payable when `leave.weekOffPayable` is on and the basis counts paid off days
  (`payableDaysBasis` other than `WORKING_DAYS`).

#### Paid quota — how many a month, and what the shortfall is worth

```ts
weekOff: {
  quotaPerMonth: number | null,   // null = whatever the weekly-off pattern gives
  paid: boolean,
  payUnused: {
    enabled: boolean,
    rate: { type: "NORMAL_DAY" }
        | { type: "MULTIPLIER"; value: number }
        | { type: "OVERTIME_RATE" },
  },
}
```

`quotaPerMonth` is the company-wide number. `Designation.weekOffsPerMonth`
overrides it for a role — the "Paid week offs a month" column on the
leave-balances screen — and `Employee.weekOffsPerMonth` overrides that for one
person, from their profile. `buildPayrollInput` walks the ladder into
`PayrollInput.weekOffQuota`, and the engine reads `input.weekOffQuota ??
weekOff.quotaPerMonth`. Null and undefined both climb: a role nobody has set is
not a role owed nothing.

Today exactly one rule reads the quota — **pay for week offs not taken**. The
shortfall is `quota − weekOffDays`, **capped at `extraDays`**: a rest day that
was worked becomes `EXTRA_DAY` and leaves the week-off count, so the cap is what
stops this paying for a day nobody worked. A month whose calendar simply gave
fewer rest days than the quota promised is the roster's problem, not the
payslip's. Nothing is credited when `paid` is false or `payUnused.enabled` is
false: you cannot be owed cash for an entitlement that was never worth
anything. The quota does not add rest days to anybody's calendar and does not
decide whether a rest day is payable — that is still `leave.weekOffPayable`.

**The zod entry is `.default()`, not required, and that is load-bearing.**
`getPayrollPolicy` refuses a payload that will not parse and falls back to
`DEFAULT_PAYROLL_POLICY`, deliberately, so a malformed policy cannot quietly pay
the wrong amount. Every stored policy predates this key, so a required one would
have failed all of them and reverted live salary components to the shipped
defaults on deploy. `src/domain/payroll/weekOff.test.ts` parses the real
production payload and asserts it still succeeds.

The whole block ships off, with no quota. A default that pays more reaches every
organisation on deploy and changes a salary nobody asked to change.

#### On-demand week off — an extra rest day, requested like leave

A `LeaveType` carrying `isWeekOff`. Provisioning seeds it as **On-demand Week
Off**: 48 a year accruing four a month, paid, switched on, and `maxPerMonth` 4.
The migration that added the column renamed every existing `isWeekOff` type the
same way and set its cap to its monthly accrual, because that is what the type
always was — a leave can never be booked on a pattern rest day, so every day it
granted was already on top of the pattern.

`LeaveType.maxPerMonth` caps the `PENDING` + `APPROVED` days of the type one
person may hold in a calendar month; null means no cap and the annual pool is
the only limit. Without it a bank of accrued rest days could be spent eight in
one month.

It is allocated **per person**, on the balance grid (`LeaveBalance.allocated`),
never per designation: the designation grid leaves the type out and
`setDesignationAllocation` refuses it, because a role-wide figure for it sat
beside the paid quota as a second "week offs a month" that meant something
else.

What an on-demand day does:

* **Leave** — validated like any other request, then charged against the
  person's balance for that type. Pattern rest days inside the span are
  `skipped` exactly as above, so it is never spent on a day that was already
  off.
* **Attendance** — approval writes `WEEK_OFF` rather than `PAID_LEAVE`
  (`domain/leave/attendanceDays.ts`), and that single difference is the whole
  link to payroll. Writing `PAID_LEAVE` there instead would make a booked rest
  day paid leave in payroll, spend a leave balance, and never count towards the
  quota.
* **Payroll** — it lands in `weekOffDays`, so it is paid the way every rest day
  is (under `leave.weekOffPayable`) and it counts towards the paid quota: a
  taken on-demand day reduces the unused shortfall above.

Whether it is *paid* is still `leave.weekOffPayable` in the payroll policy, not
`LeaveType.paid` — two answers to one question is how they come to disagree.

Every other leave type arrives switched **off** and appears to employees only
once an administrator has set the days and the frequency; `saveLeaveType`
refuses to activate one that grants nothing, except where the accrual mode is
`NONE` (leave without pay grants nothing by definition, and a compensatory off
is credited by payroll).

### Where a leave day comes from

Approved leave writes an `AttendanceDay` — `PAID_LEAVE`, `UNPAID_LEAVE`,
`HALF_DAY` or nothing — through the one pure decision in
`domain/leave/attendanceDays.ts`, and `buildPayrollInput` asks the same function
again for any day attendance never wrote.

Before round 7 it wrote none of them: `decideLeave` moved the balance and told
payroll nothing, `buildPayrollInput` never read a leave request, and
`statusForMissingAttendance` called the working day `ABSENT`. An approved, paid
day off was docked from the salary **and** spent from the balance.

Presence beats the claim: a day already carrying a real check-in is left alone.
A half-day claim on a day that was worked becomes `FULL_DAY` when the type is
paid and `HALF_DAY` when it is not; unworked, `HALF_DAY` and `ABSENT`
respectively. The seven cases are a table in the file.

### Overtime (§15)
`{ enabled, afterMinutesPerDay, rate: { type:"MULTIPLIER"|"FLAT_PER_HOUR", value }, cap? }`

### Training / probation (§12)
`SalaryProfile.employmentState` + `TrainingPlan { startDate, endDate, mode:
 PERCENT|FIXED|UNPAID, percent?, fixedAmount?, postTrainingState, postTrainingCtc? }`.
The engine picks the effective CTC **per day** in the period, so a mid-month training
end prorates correctly across both rates.

## Pipeline (§44) — `domain/payroll/pipeline.ts`

Each stage is `(ctx: PayrollContext, acc: PayrollAccumulator) => StageResult` and pushes
`TraceLine { stage, label, formula, inputs, amount }`.

| # | Stage | Produces |
|---|---|---|
| 1 | `resolvePeriod` | period start/end, calendar days |
| 2 | `resolveEmployment` | active days, employment state segments (training/probation/regular) |
| 3 | `resolveSalaryStructure` | effective CTC per segment, component amounts |
| 4 | `resolveCalendar` | working days, week-offs, holidays (from `domain/calendar`) |
| 5 | `resolveAttendance` | per-day status ledger (present/half/absent/leave/extra/holiday) |
| 6 | `computePayableDays` | payable = f(basis, present, paidLeave, paidHoliday, weekOff) |
| 7 | `prorateEarnings` | prorated components × (payableDays / basisDays) |
| 8 | `lateDeduction` | from late occurrences |
| 9 | `earlyLeaveDeduction` | |
| 10 | `unpaidLeaveDeduction` | |
| 11 | `extraDayCredit` | cash or comp-off |
| 12 | `overtimeCredit` | |
| 13 | `bonusIncentiveReimbursement` | manual adjustments typed `EARNING` |
| 14 | `statutoryDeductions` | PF/ESI/PT/TDS — only if org enables them |
| 15 | `otherDeductions` | manual adjustments typed `DEDUCTION` |
| 16 | `advanceRecovery` | per `AdvanceRecoveryPolicy`, updates advance balance |
| 17 | `applyManualAdjustments` | authorised overrides, each with reason + actor |
| 18 | `round` | per rounding config |
| 19 | `explain` | gross, totalDeductions, net + full trace |

Result:
```ts
type PayrollResult = {
  gross: Money; totalEarnings: Money; totalDeductions: Money; net: Money;
  payableDays: number; basisDays: number;
  earnings: LineItem[]; deductions: LineItem[];
  trace: TraceLine[];            // rendered in the UI "How was this calculated?" drawer
  warnings: string[];
};
```

## Determinism & money
* All money is **integer paise**; `domain/payroll/money.ts` has `mul`, `pct`, `div`
  with banker's-rounding at a single choke point. No `number` division elsewhere.
* Same inputs + same policy version ⇒ byte-identical result. Enforced by a snapshot test.

## Finalisation & immutability (§25, §48)
`DRAFT → CALCULATED → APPROVED → LOCKED → PAID(partial/full)`.
On `LOCKED` the run stores `policySnapshot`, `inputSnapshot` (attendance ledger, advances,
adjustments) and the computed `PayrollItem` rows. Recalculation of a LOCKED run is refused;
`payroll.unlock` (OWNER only) creates a new **revision** rather than mutating history.
The revision starts with the source run's one-off adjustments copied onto it (audited as
`adjustmentsCarried`); remove any that should no longer apply before recalculating. An
APPROVED run takes no new adjustments at all -- lock it and reopen a revision.

## AI-assisted configuration (§26, §46)
The AI never executes code and never writes the policy directly:
```
Admin natural language ─► OpenRouter (glm-5.3-flash, JSON mode, strict schema in prompt)
   ─► zod parse against PayrollPolicySchema  (reject on failure, show raw + errors)
   ─► conflict/assumption analyser (domain/payroll/analyze.ts)
   ─► preview: rules list + sample calculation on 3 synthetic employees
   ─► Admin explicit "Approve & activate"  ─► new OrgPolicyVersion (effectiveFrom)
```
Rejected reasons are shown verbatim. Nothing is activated without the approval click.

## Simulator (§27)
`POST /api/org/payroll/simulate` takes a hypothetical employee + a *draft* policy and
returns the full `PayrollResult` including trace — no DB writes, no employee needed.
