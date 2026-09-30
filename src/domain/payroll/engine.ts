/**
 * The payroll calculation pipeline.
 *
 * Deterministic and explainable: identical inputs and policy always produce an
 * identical result, and every amount that lands on a payslip has a `TraceLine`
 * saying how it was derived.
 *
 * A note on the single most common payroll bug — double counting. Day-based pay
 * has exactly ONE mechanism here: proration by payable days. Absences, unpaid
 * leave and the unpaid half of a half-day are simply missing from the numerator,
 * so the employee loses the natural per-day rate automatically. The deduction
 * stages only add penalties *beyond* that natural loss. Nothing subtracts a day
 * twice.
 */

import {
  type Money,
  applyRounding,
  clampNonNegative,
  div,
  formatPaise,
  mul,
  pct,
  ratio,
  sum,
} from "../money";
import { type DateOnly, diffDays, max as maxDate, min as minDate } from "../date";
import { resolveSalaryStructure } from "./policy";
import type {
  AdvanceInput,
  DayCounts,
  EarlyLeaveRule,
  EmploymentSegment,
  LateDeductionRule,
  LineItem,
  PayrollInput,
  PayrollPolicy,
  PayrollResult,
  SalaryComponent,
  TraceLine,
} from "./types";

interface Accumulator {
  earnings: LineItem[];
  deductions: LineItem[];
  trace: TraceLine[];
  warnings: string[];
  compOffDays: number;
}

/**
 * Money inside a trace formula, and inside a warning.
 *
 * The engine works in paise, but a formula reading "12500000 × 27/31" is
 * unreadable to the person checking their own payslip. The structured `inputs`
 * keep the exact integers for anything that needs them.
 *
 * This writes a real rupee sign, and it is right to: the trace is read on
 * screen. What it must not do is assume the same is true of everything
 * downstream -- `warnings` is stored on the payroll item and printed into the
 * payslip PDF, where a font without U+20B9 draws a superscript one instead.
 * That is fixed at the PDF boundary by `toPdfSafeText`, rather than by making
 * this function pretend the whole product is a PDF.
 */
function money(paise: Money): string {
  return formatPaise(paise);
}

function line(
  stage: string,
  label: string,
  formula: string,
  inputs: Record<string, string | number>,
  amountPaise: Money,
): TraceLine {
  return { stage, label, formula, inputs, amountPaise };
}

function addEarning(acc: Accumulator, item: LineItem): void {
  if (item.amountPaise === 0) return;
  acc.earnings.push(item);
}

function addDeduction(acc: Accumulator, item: LineItem): void {
  if (item.amountPaise === 0) return;
  acc.deductions.push(item);
}

// ------------------------------------------------------------------ stage 2

/** Days of a segment that fall inside the payroll period. */
function segmentDays(segment: EmploymentSegment, start: DateOnly, end: DateOnly): number {
  const from = maxDate(segment.from, start);
  const to = minDate(segment.to, end);
  if (from > to) return 0;
  return diffDays(from, to) + 1;
}

/** Effective monthly CTC for a segment, after training rules. */
export function segmentCtc(segment: EmploymentSegment, policy: PayrollPolicy): Money {
  if (segment.state !== "TRAINING") return segment.ctcMonthlyPaise;

  const training = segment.training ?? {
    mode: policy.training.defaultMode,
    percent: policy.training.defaultPercent,
  };

  switch (training.mode) {
    case "UNPAID":
      return 0;
    case "FIXED":
      return training.fixedAmountPaise ?? 0;
    case "PERCENT":
    default:
      return pct(segment.ctcMonthlyPaise, training.percent ?? policy.training.defaultPercent);
  }
}

/**
 * Blends the CTC across employment segments, weighted by days in the period, so
 * a training plan ending mid-month prorates across both rates.
 */
function resolveEffectiveCtc(
  input: PayrollInput,
  policy: PayrollPolicy,
  acc: Accumulator,
): Money {
  const { start, end } = input.period;
  const totalDays = diffDays(start, end) + 1;

  if (input.segments.length === 0) {
    acc.trace.push(
      line("RESOLVE_SALARY", "Monthly CTC", "declared salary", { ctc: input.ctcMonthlyPaise }, input.ctcMonthlyPaise),
    );
    return input.ctcMonthlyPaise;
  }

  const parts = input.segments
    .map((s) => ({ segment: s, days: segmentDays(s, start, end) }))
    .filter((p) => p.days > 0);

  if (parts.length === 0) {
    acc.warnings.push("No employment segment overlaps this payroll period.");
    return input.ctcMonthlyPaise;
  }

  const coveredDays = sum(parts.map((p) => p.days));
  if (coveredDays < totalDays) {
    acc.warnings.push(
      `Employment segments cover ${coveredDays} of ${totalDays} days; uncovered days are treated as not on roll.`,
    );
  }

  // A single segment covering the whole period needs no blending.
  if (parts.length === 1 && parts[0] && !policy.training.prorateAcrossTransition) {
    const only = parts[0];
    const ctc = segmentCtc(only.segment, policy);
    acc.trace.push(
      line("RESOLVE_SALARY", `CTC (${only.segment.state.toLowerCase()})`, "segment rate", { days: only.days, ctc }, ctc),
    );
    return ctc;
  }

  let blended = 0;
  for (const part of parts) {
    const ctc = segmentCtc(part.segment, policy);
    const weight = ratio(part.days, coveredDays);
    const contribution = mul(ctc, weight);
    blended += contribution;
    acc.trace.push(
      line(
        "RESOLVE_SALARY",
        `CTC segment — ${part.segment.state.toLowerCase()}`,
        `${money(ctc)} × ${part.days}/${coveredDays} days`,
        { state: part.segment.state, segmentCtc: ctc, days: part.days, of: coveredDays },
        contribution,
      ),
    );
  }

  acc.trace.push(
    line("RESOLVE_SALARY", "Effective monthly CTC", "sum of weighted segments", { segments: parts.length }, blended),
  );
  return blended;
}

// ------------------------------------------------------------------ stages 4–6

export function countDays(input: PayrollInput, policy: PayrollPolicy): DayCounts {
  const half = policy.attendance.halfDayFactor;
  let presentDays = 0;
  let halfDays = 0;
  let absentDays = 0;
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  let weekOffDays = 0;
  let holidayDays = 0;
  let extraDays = 0;
  let lateCount = 0;
  let earlyLeaveCount = 0;
  let overtimeMinutes = 0;

  for (const day of input.ledger) {
    switch (day.status) {
      case "FULL_DAY":
      case "ON_DUTY":
      case "TRAINING_DAY":
        presentDays += 1;
        break;
      case "HALF_DAY":
        halfDays += 1;
        presentDays += half;
        break;
      case "ABSENT":
        absentDays += 1;
        break;
      case "PAID_LEAVE":
        paidLeaveDays += 1;
        break;
      case "UNPAID_LEAVE":
        unpaidLeaveDays += 1;
        break;
      case "WEEK_OFF":
      case "DAY_OFF":
        weekOffDays += 1;
        break;
      case "HOLIDAY":
        holidayDays += 1;
        break;
      case "EXTRA_DAY":
        extraDays += 1;
        break;
      default:
        break;
    }
    if (day.isLate) lateCount += 1;
    if (day.earlyLeaveMinutes > 0) earlyLeaveCount += 1;
    overtimeMinutes += day.overtimeMinutes;
  }

  const basisDays = resolveBasisDays(input, policy);

  // An extra day was a rest day before it was worked, so it keeps its paid-off
  // status here; the extra-day stage adds the additional compensation on top.
  const includePaidOff = policy.payableDaysBasis !== "WORKING_DAYS";
  const paidOff =
    (includePaidOff && policy.leave.weekOffPayable ? weekOffDays : 0) +
    (includePaidOff && policy.leave.holidayPayable ? holidayDays : 0) +
    (includePaidOff ? extraDays : 0);

  const payableDays =
    presentDays +
    (policy.leave.paidLeaveIsPayable ? paidLeaveDays : 0) +
    (policy.leave.unpaidLeaveDeducted ? 0 : unpaidLeaveDays) +
    paidOff;

  return {
    basisDays,
    payableDays: Math.min(payableDays, basisDays),
    presentDays,
    halfDays,
    absentDays,
    paidLeaveDays,
    unpaidLeaveDays,
    weekOffDays,
    holidayDays,
    extraDays,
    lateCount,
    earlyLeaveCount,
    overtimeMinutes,
  };
}

function resolveBasisDays(input: PayrollInput, policy: PayrollPolicy): number {
  const c = input.calendar;
  switch (policy.payableDaysBasis) {
    case "FIXED_30":
      return 30;
    case "WORKING_DAYS":
      return c.workingDays;
    case "WORKING_DAYS_PLUS_PAID_OFF":
      return (
        c.workingDays +
        (policy.leave.weekOffPayable ? c.weekOffDays : 0) +
        (policy.leave.holidayPayable ? c.paidHolidayDays : 0)
      );
    case "CALENDAR_DAYS":
    default:
      return c.totalDays;
  }
}

// ------------------------------------------------------------------ deductions

function occurrenceDeduction(
  rule: LateDeductionRule | EarlyLeaveRule,
  occurrences: number,
  minutes: number,
  perDayRate: Money,
  perMinuteRate: Money,
  halfDayFactor: number,
): { amount: Money; formula: string; inputs: Record<string, string | number> } {
  switch (rule.type) {
    case "NONE":
      return { amount: 0, formula: "no penalty configured", inputs: {} };
    case "PER_OCCURRENCE": {
      const chargeable = Math.max(0, occurrences - rule.freeCount);
      return {
        amount: chargeable * rule.amountPaise,
        formula: `max(0, ${occurrences} − ${rule.freeCount} free) × ${money(rule.amountPaise)}`,
        inputs: { occurrences, free: rule.freeCount, perOccurrence: rule.amountPaise },
      };
    }
    case "HALF_DAY_PER_N": {
      const chargeable = Math.max(0, occurrences - rule.freeCount);
      const halfDays = Math.floor(chargeable / rule.n);
      return {
        amount: mul(perDayRate, halfDays * halfDayFactor),
        formula: `floor(max(0, ${occurrences} − ${rule.freeCount}) / ${rule.n}) = ${halfDays} half-day(s) × ${money(perDayRate)} × ${halfDayFactor}`,
        inputs: { occurrences, free: rule.freeCount, per: rule.n, halfDays, perDayRate },
      };
    }
    case "PRORATA_MINUTES": {
      const chargeable = Math.max(0, minutes - rule.freeMinutes);
      return {
        amount: chargeable * perMinuteRate,
        formula: `max(0, ${minutes} − ${rule.freeMinutes} free) min × ${money(perMinuteRate)}/min`,
        inputs: { minutes, free: rule.freeMinutes, perMinute: perMinuteRate },
      };
    }
    default:
      return { amount: 0, formula: "unknown rule", inputs: {} };
  }
}

// ------------------------------------------------------------------ the pipeline

export function calculatePayroll(input: PayrollInput, policy: PayrollPolicy): PayrollResult {
  const acc: Accumulator = { earnings: [], deductions: [], trace: [], warnings: [], compOffDays: 0 };

  // 1–2 — period and employment
  acc.trace.push(
    line(
      "PERIOD",
      "Payroll period",
      "configured cycle",
      { start: input.period.start, end: input.period.end, basis: policy.payableDaysBasis },
      0,
    ),
  );
  const effectiveCtc = resolveEffectiveCtc(input, policy, acc);

  // 3 — salary structure
  const components: SalaryComponent[] = input.componentOverrides ?? policy.components;
  const structure = resolveSalaryStructure(effectiveCtc, components, policy.percentBase);
  if (structure.roundingResidualPaise !== 0) {
    acc.trace.push(
      line(
        "RESOLVE_SALARY",
        "Rounding residual absorbed",
        "components adjusted to total the CTC exactly",
        { residual: structure.roundingResidualPaise },
        structure.roundingResidualPaise,
      ),
    );
  }

  // 4–6 — calendar, attendance, payable days
  const days = countDays(input, policy);
  const dayRatio = ratio(days.payableDays, days.basisDays);
  const perDayRate = div(effectiveCtc, days.basisDays);
  const perMinuteRate = div(perDayRate, policy.overtime.standardHoursPerDay * 60);

  acc.trace.push(
    line(
      "PAYABLE_DAYS",
      "Payable days",
      `present ${days.presentDays} + paid leave ${days.paidLeaveDays} + paid off ${days.weekOffDays + days.holidayDays + days.extraDays}`,
      {
        payableDays: days.payableDays,
        basisDays: days.basisDays,
        absent: days.absentDays,
        unpaidLeave: days.unpaidLeaveDays,
        halfDays: days.halfDays,
      },
      0,
    ),
  );
  acc.trace.push(
    line("PAYABLE_DAYS", "Per-day rate", `${money(effectiveCtc)} ÷ ${days.basisDays} days`, { perDayRate }, perDayRate),
  );

  const enabled = new Set(policy.stages);

  // 7 — prorate earnings
  for (const resolved of structure.earnings) {
    const full = resolved.amountPaise;
    const prorate = enabled.has("PRORATE_EARNINGS") && resolved.component.prorated;
    const amount = prorate ? mul(full, dayRatio) : full;
    addEarning(acc, {
      code: resolved.component.code,
      label: resolved.component.name,
      amountPaise: amount,
      kind: "EARNING",
      prorated: prorate,
      showOnSlip: resolved.component.showOnSlip,
    });
    acc.trace.push(
      line(
        "PRORATE_EARNINGS",
        resolved.component.name,
        prorate
          ? `${resolved.formula} → ${money(full)} × ${days.payableDays}/${days.basisDays}`
          : `${resolved.formula} (not prorated)`,
        { full, payableDays: days.payableDays, basisDays: days.basisDays },
        amount,
      ),
    );
  }

  // Fixed deduction components declared in the structure.
  for (const resolved of structure.deductions) {
    addDeduction(acc, {
      code: resolved.component.code,
      label: resolved.component.name,
      amountPaise: resolved.amountPaise,
      kind: "DEDUCTION",
      prorated: false,
      showOnSlip: resolved.component.showOnSlip,
    });
    acc.trace.push(
      line("PRORATE_EARNINGS", resolved.component.name, resolved.formula, {}, -resolved.amountPaise),
    );
  }

  // Absence beyond the natural per-day loss.
  if (days.absentDays > 0) {
    const rule = policy.attendance.absent;
    if (rule.type === "PER_DAY_RATE") {
      acc.trace.push(
        line(
          "ABSENCE",
          "Absent days",
          `${days.absentDays} day(s) excluded from payable days at ${money(perDayRate)}/day; no extra penalty configured`,
          { absentDays: days.absentDays, perDayRate },
          -mul(perDayRate, days.absentDays),
        ),
      );
    } else if (rule.type === "MULTIPLIER" && rule.multiplier > 1) {
      const extra = mul(perDayRate, days.absentDays * (rule.multiplier - 1));
      addDeduction(acc, {
        code: "ABSENT_PENALTY",
        label: "Absence penalty",
        amountPaise: extra,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
      acc.trace.push(
        line(
          "ABSENCE",
          "Absence penalty",
          `${days.absentDays} × ${money(perDayRate)} × (${rule.multiplier} − 1)`,
          { absentDays: days.absentDays, multiplier: rule.multiplier },
          -extra,
        ),
      );
    } else if (rule.type === "FIXED_PER_DAY") {
      const natural = mul(perDayRate, days.absentDays);
      const fixed = rule.amountPaise * days.absentDays;
      const delta = fixed - natural;
      if (delta > 0) {
        addDeduction(acc, {
          code: "ABSENT_PENALTY",
          label: "Absence penalty",
          amountPaise: delta,
          kind: "DEDUCTION",
          prorated: false,
          showOnSlip: true,
        });
      } else if (delta < 0) {
        addEarning(acc, {
          code: "ABSENT_RELIEF",
          label: "Absence adjustment",
          amountPaise: -delta,
          kind: "EARNING",
          prorated: false,
          showOnSlip: true,
        });
      }
      acc.trace.push(
        line(
          "ABSENCE",
          "Absence at fixed rate",
          `${days.absentDays} × ${money(rule.amountPaise)} fixed vs ${money(natural)} natural loss`,
          { absentDays: days.absentDays, fixedPerDay: rule.amountPaise, natural },
          -delta,
        ),
      );
    }
  }

  // 8 — late
  if (enabled.has("LATE_DEDUCTION")) {
    const lateMinutes = sum(input.ledger.map((d) => d.lateMinutes));
    const result = occurrenceDeduction(
      policy.attendance.late,
      days.lateCount,
      lateMinutes,
      perDayRate,
      perMinuteRate,
      policy.attendance.halfDayFactor,
    );
    if (result.amount > 0) {
      addDeduction(acc, {
        code: "LATE",
        label: "Late arrival deduction",
        amountPaise: result.amount,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
    }
    acc.trace.push(
      line("LATE_DEDUCTION", "Late arrivals", result.formula, { ...result.inputs, lateCount: days.lateCount }, -result.amount),
    );
  }

  // 9 — early departure
  if (enabled.has("EARLY_LEAVE_DEDUCTION")) {
    const earlyMinutes = sum(input.ledger.map((d) => d.earlyLeaveMinutes));
    const result = occurrenceDeduction(
      policy.attendance.earlyLeave,
      days.earlyLeaveCount,
      earlyMinutes,
      perDayRate,
      perMinuteRate,
      policy.attendance.halfDayFactor,
    );
    if (result.amount > 0) {
      addDeduction(acc, {
        code: "EARLY_LEAVE",
        label: "Early departure deduction",
        amountPaise: result.amount,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
    }
    acc.trace.push(
      line("EARLY_LEAVE_DEDUCTION", "Early departures", result.formula, result.inputs, -result.amount),
    );
  }

  // 10 — unpaid leave (explanatory: already excluded from payable days)
  if (enabled.has("UNPAID_LEAVE_DEDUCTION") && days.unpaidLeaveDays > 0) {
    const implied = policy.leave.unpaidLeaveDeducted ? mul(perDayRate, days.unpaidLeaveDays) : 0;
    acc.trace.push(
      line(
        "UNPAID_LEAVE_DEDUCTION",
        "Unpaid leave",
        policy.leave.unpaidLeaveDeducted
          ? `${days.unpaidLeaveDays} day(s) excluded from payable days at ${money(perDayRate)}/day`
          : `${days.unpaidLeaveDays} day(s) paid by policy`,
        { unpaidLeaveDays: days.unpaidLeaveDays, perDayRate },
        -implied,
      ),
    );
  }

  // 11 — extra day
  if (enabled.has("EXTRA_DAY_CREDIT") && days.extraDays > 0) {
    const rule = policy.extraDay;
    switch (rule.mode) {
      case "MULTIPLIER": {
        const credit = mul(perDayRate, days.extraDays * rule.multiplier);
        addEarning(acc, {
          code: "EXTRA_DAY",
          label: "Extra day pay",
          amountPaise: credit,
          kind: "EARNING",
          prorated: false,
          showOnSlip: true,
        });
        acc.trace.push(
          line(
            "EXTRA_DAY_CREDIT",
            "Extra day pay",
            `${days.extraDays} day(s) × ${money(perDayRate)} × ${rule.multiplier}`,
            { extraDays: days.extraDays, multiplier: rule.multiplier, perDayRate },
            credit,
          ),
        );
        break;
      }
      case "COMP_OFF": {
        acc.compOffDays = days.extraDays * rule.daysPerExtraDay;
        acc.trace.push(
          line(
            "EXTRA_DAY_CREDIT",
            "Compensatory off credited",
            `${days.extraDays} × ${rule.daysPerExtraDay} day(s) to ${rule.leaveTypeCode}`,
            { extraDays: days.extraDays, leaveType: rule.leaveTypeCode, credited: acc.compOffDays },
            0,
          ),
        );
        break;
      }
      case "OVERTIME_RATE":
        acc.trace.push(
          line(
            "EXTRA_DAY_CREDIT",
            "Extra days paid as overtime",
            "hours are credited by the overtime stage",
            { extraDays: days.extraDays },
            0,
          ),
        );
        break;
      case "NORMAL_DAY":
      default:
        acc.trace.push(
          line(
            "EXTRA_DAY_CREDIT",
            "Extra days treated as ordinary paid days",
            "already included in payable days; no additional pay configured",
            { extraDays: days.extraDays },
            0,
          ),
        );
        break;
    }
  }

  // 12 — overtime
  if (enabled.has("OVERTIME_CREDIT") && policy.overtime.enabled && days.overtimeMinutes > 0) {
    const capped =
      policy.overtime.maxPayableMinutesPerMonth > 0
        ? Math.min(days.overtimeMinutes, policy.overtime.maxPayableMinutesPerMonth)
        : days.overtimeMinutes;

    const basicAmount =
      structure.earnings.find((e) => e.component.code === "BASIC")?.amountPaise ?? effectiveCtc;
    const hourlyBase =
      policy.overtime.hourlyBasis === "BASIC_PER_HOUR"
        ? div(div(basicAmount, days.basisDays), policy.overtime.standardHoursPerDay)
        : div(perDayRate, policy.overtime.standardHoursPerDay);

    const hours = capped / 60;
    const credit =
      policy.overtime.rate.type === "FLAT_PER_HOUR"
        ? mul(policy.overtime.rate.amountPaise, hours)
        : mul(hourlyBase, hours * policy.overtime.rate.value);

    addEarning(acc, {
      code: "OVERTIME",
      label: "Overtime",
      amountPaise: credit,
      kind: "EARNING",
      prorated: false,
      showOnSlip: true,
    });
    acc.trace.push(
      line(
        "OVERTIME_CREDIT",
        "Overtime",
        policy.overtime.rate.type === "FLAT_PER_HOUR"
          ? `${hours.toFixed(2)} h × ${money(policy.overtime.rate.amountPaise)}/h`
          : `${hours.toFixed(2)} h × ${money(hourlyBase)}/h × ${policy.overtime.rate.value}`,
        { minutes: days.overtimeMinutes, capped, hourlyBase },
        credit,
      ),
    );
  }

  /**
   * Rest days somebody was owed and did not get.
   *
   * Not a stage of its own, deliberately. `stages` is stored per organisation
   * and every stored list was written before this existed, so a new stage would
   * be absent from all of them and the rule would be unreachable for exactly
   * the organisations that switched it on. It gates on its own `enabled` flag
   * instead, which is off in the shipped default.
   *
   * `weekOffDays` counts the rest days actually taken, because a rest day that
   * was worked becomes `EXTRA_DAY` and leaves that count. The shortfall against
   * the quota is therefore what was owed and not taken — capped at `extraDays`
   * so this can never pay for a day nobody worked, which is the failure mode
   * that would turn a generous rule into a wrong payslip.
   *
   * Only when rest days are paid at all: "agar paid hai to" was the condition,
   * and paying for an unpaid entitlement would be paying twice for nothing.
   */
  const weekOff = policy.weekOff;
  const quota = input.weekOffQuota ?? weekOff.quotaPerMonth;
  if (weekOff.payUnused.enabled && weekOff.paid && quota !== null) {
    const owed = Math.max(0, quota - days.weekOffDays);
    const unused = Math.min(owed, days.extraDays);

    if (unused > 0) {
      const basicAmount =
        structure.earnings.find((e) => e.component.code === "BASIC")?.amountPaise ?? effectiveCtc;
      const hourlyBase =
        policy.overtime.hourlyBasis === "BASIC_PER_HOUR"
          ? div(div(basicAmount, days.basisDays), policy.overtime.standardHoursPerDay)
          : div(perDayRate, policy.overtime.standardHoursPerDay);

      const rate = weekOff.payUnused.rate;
      const dayValue =
        rate.type === "MULTIPLIER"
          ? mul(perDayRate, rate.value)
          : rate.type === "OVERTIME_RATE"
            ? // A whole day at the overtime hourly rate, which is what "add it
              // as overtime" means when the unit being added is a day.
              policy.overtime.rate.type === "FLAT_PER_HOUR"
              ? mul(policy.overtime.rate.amountPaise, policy.overtime.standardHoursPerDay)
              : mul(hourlyBase, policy.overtime.standardHoursPerDay * policy.overtime.rate.value)
            : perDayRate;

      const credit = mul(dayValue, unused);
      addEarning(acc, {
        code: "WEEK_OFF_UNUSED",
        label: "Unused week offs",
        amountPaise: credit,
        kind: "EARNING",
        prorated: false,
        showOnSlip: true,
      });
      acc.trace.push(
        line(
          "EXTRA_DAY_CREDIT",
          "Unused week offs",
          `${unused} of ${quota} not taken x ${money(dayValue)}`,
          {
            quota,
            taken: days.weekOffDays,
            worked: days.extraDays,
            unused,
            dayValue,
          },
          credit,
        ),
      );
    }
  }

  // 13 — manual adjustments (bonus, incentive, reimbursement, arrears, corrections)
  let adjustmentEarnings = 0;
  if (enabled.has("ADJUSTMENTS")) {
    for (const adj of input.adjustments) {
      const item: LineItem = {
        code: adj.code,
        label: adj.label,
        amountPaise: adj.amountPaise,
        kind: adj.kind,
        prorated: false,
        showOnSlip: true,
      };
      if (adj.kind === "EARNING") {
        addEarning(acc, item);
        // Remembered so the statutory base below can exclude it. A
        // reimbursement of an actual expense is not a wage, and letting one
        // into the ESI base either over-deducts or -- worse -- pushes somebody
        // over the ceiling and stops their ESI for the month.
        adjustmentEarnings += adj.amountPaise;
      } else addDeduction(acc, item);
      acc.trace.push(
        line(
          "ADJUSTMENTS",
          adj.label,
          adj.reason ? `manual adjustment — ${adj.reason}` : "manual adjustment",
          { code: adj.code },
          adj.kind === "EARNING" ? adj.amountPaise : -adj.amountPaise,
        ),
      );
    }
  }

  // 14 — statutory
  /**
   * The wage base the statutory deductions are worked out on.
   *
   * **Manual adjustments are excluded.** They were not, and the consequence was
   * quiet: a reimbursement -- somebody's train fare, paid back -- counted as
   * wages for ESI, so either their ESI went up because the company repaid an
   * expense, or the inflated figure crossed the wage ceiling and their ESI
   * stopped altogether for that month. Neither is a decision anybody made.
   *
   * This does mean a genuine *bonus* entered as an adjustment is also excluded,
   * which is the less wrong of the two: an adjustment carries no field saying
   * whether it is wages, so the choice is between under-counting a bonus and
   * over-counting an expense repayment, and only one of those can silently
   * remove somebody's insurance.
   */
  const grossSoFar = sum(acc.earnings.map((e) => e.amountPaise)) - adjustmentEarnings;
  if (enabled.has("STATUTORY_DEDUCTIONS")) {
    const s = policy.statutory;

    if (s.providentFund.enabled) {
      /**
       * PF is a percentage of one named component, and of nothing else.
       *
       * This used to fall back to the whole gross when that component was not
       * found -- so deactivating BASIC on the salary structure screen, months
       * after the policy was written, silently turned a 12% deduction on basic
       * into 12% of everything. The guard at save time cannot see a change made
       * later on a different screen.
       *
       * Now a missing component means no PF and a warning that says why. Not
       * deducting is recoverable in the next run; over-deducting has already
       * come out of somebody's pay.
       */
      const source = acc.earnings.find((e) => e.code === s.providentFund.componentCode);
      const sourceAmount = source?.amountPaise ?? null;
      const capped =
        sourceAmount === null
          ? null
          : s.providentFund.wageCeilingPaise > 0
            ? Math.min(sourceAmount, s.providentFund.wageCeilingPaise)
            : sourceAmount;
      if (capped === null) {
        acc.warnings.push(
          `Provident fund was not deducted: the salary structure has no active "${s.providentFund.componentCode}" component to calculate it from.`,
        );
      } else {
        const amount = pct(capped, s.providentFund.employeePercent);
        addDeduction(acc, {
          code: "PF",
          label: "Provident Fund",
          amountPaise: amount,
          kind: "DEDUCTION",
          prorated: false,
          showOnSlip: true,
        });
        acc.trace.push(
          line(
            "STATUTORY_DEDUCTIONS",
            "Provident Fund",
            `${s.providentFund.employeePercent}% of min(${money(sourceAmount ?? 0)}, ceiling ${money(s.providentFund.wageCeilingPaise)})`,
            { base: capped, percent: s.providentFund.employeePercent },
            -amount,
          ),
        );
      }
    }

    if (s.esi.enabled && (s.esi.wageCeilingPaise === 0 || grossSoFar <= s.esi.wageCeilingPaise)) {
      const amount = pct(grossSoFar, s.esi.employeePercent);
      addDeduction(acc, {
        code: "ESI",
        label: "ESI",
        amountPaise: amount,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
      acc.trace.push(
        line("STATUTORY_DEDUCTIONS", "ESI", `${s.esi.employeePercent}% of gross ${money(grossSoFar)}`, { gross: grossSoFar }, -amount),
      );
    }

    if (s.professionalTax.enabled && s.professionalTax.slabs.length > 0) {
      const slab = [...s.professionalTax.slabs]
        .sort((a, b) => a.uptoPaise - b.uptoPaise)
        .find((sl) => grossSoFar <= sl.uptoPaise) ?? s.professionalTax.slabs[s.professionalTax.slabs.length - 1];
      if (slab && slab.amountPaise > 0) {
        addDeduction(acc, {
          code: "PT",
          label: "Professional Tax",
          amountPaise: slab.amountPaise,
          kind: "DEDUCTION",
          prorated: false,
          showOnSlip: true,
        });
        acc.trace.push(
          line("STATUTORY_DEDUCTIONS", "Professional Tax", `slab for gross ${money(grossSoFar)}`, { upto: slab.uptoPaise }, -slab.amountPaise),
        );
      }
    }

    if (s.incomeTax.enabled && s.incomeTax.monthlyFlatPaise > 0) {
      addDeduction(acc, {
        code: "TDS",
        label: "Income Tax (TDS)",
        amountPaise: s.incomeTax.monthlyFlatPaise,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
      acc.trace.push(
        line("STATUTORY_DEDUCTIONS", "Income Tax (TDS)", "configured monthly amount", {}, -s.incomeTax.monthlyFlatPaise),
      );
    }
  }

  // 15 — advance recovery
  const totalEarnings = sum(acc.earnings.map((e) => e.amountPaise));
  const deductionsBeforeAdvance = sum(acc.deductions.map((d) => d.amountPaise));
  const netBeforeAdvance = totalEarnings - deductionsBeforeAdvance;

  const recoveries: { advanceId: string; amountPaise: Money }[] = [];
  let advanceRecovered = 0;

  if (enabled.has("ADVANCE_RECOVERY") && input.advances.length > 0) {
    let headroom = Math.max(0, netBeforeAdvance - policy.advance.minNetPayPaise);

    for (const advance of input.advances) {
      if (advance.outstandingPaise <= 0 || headroom <= 0) continue;
      const wanted = plannedRecovery(advance, policy, netBeforeAdvance);
      const amount = Math.min(wanted, advance.outstandingPaise, headroom);
      if (amount <= 0) continue;

      recoveries.push({ advanceId: advance.id, amountPaise: amount });
      advanceRecovered += amount;
      headroom -= amount;

      acc.trace.push(
        line(
          "ADVANCE_RECOVERY",
          "Salary advance recovery",
          describeRecovery(advance, policy, wanted, amount),
          {
            advanceId: advance.id,
            outstanding: advance.outstandingPaise,
            planned: wanted,
            minNetPay: policy.advance.minNetPayPaise,
          },
          -amount,
        ),
      );
    }

    if (advanceRecovered > 0) {
      addDeduction(acc, {
        code: "ADVANCE",
        label: "Salary advance recovery",
        amountPaise: advanceRecovered,
        kind: "DEDUCTION",
        prorated: false,
        showOnSlip: true,
      });
    }

    const stillOwed = sum(input.advances.map((a) => a.outstandingPaise)) - advanceRecovered;
    if (stillOwed > 0) {
      acc.warnings.push(
        `${money(stillOwed)} of advance carries forward; the minimum net-pay floor limited this month's recovery.`,
      );
    }
  }

  // 16 — rounding
  const totalDeductions = sum(acc.deductions.map((d) => d.amountPaise));
  const rawNet = totalEarnings - totalDeductions;
  const net = enabled.has("ROUNDING") ? applyRounding(rawNet, policy.rounding) : rawNet;

  if (net !== rawNet) {
    acc.trace.push(
      line(
        "ROUNDING",
        "Rounding adjustment",
        `${policy.rounding.mode.toLowerCase()} to ${policy.rounding.to} paise`,
        { before: rawNet, after: net },
        net - rawNet,
      ),
    );
  }

  acc.trace.push(
    line(
      "RESULT",
      "Net payable",
      `earnings ${money(totalEarnings)} − deductions ${money(totalDeductions)}`,
      { earnings: totalEarnings, deductions: totalDeductions },
      net,
    ),
  );

  if (net < 0) {
    acc.warnings.push("Net pay is negative; review deductions and adjustments before locking payroll.");
  }

  return {
    employeeId: input.employee.id,
    period: { year: input.period.year, month: input.period.month },
    ctcMonthlyPaise: effectiveCtc,
    days,
    earnings: acc.earnings,
    deductions: acc.deductions,
    grossPaise: totalEarnings,
    totalEarningsPaise: totalEarnings,
    totalDeductionsPaise: totalDeductions,
    advanceRecoveredPaise: advanceRecovered,
    advanceRecoveries: recoveries,
    netPaise: net,
    compOffCredits:
      acc.compOffDays > 0 && policy.extraDay.mode === "COMP_OFF"
        ? [{ leaveTypeCode: policy.extraDay.leaveTypeCode, days: acc.compOffDays }]
        : [],
    trace: acc.trace,
    warnings: acc.warnings,
  };
}

function plannedRecovery(advance: AdvanceInput, policy: PayrollPolicy, net: Money): Money {
  const mode = advance.recovery ?? policy.advance.defaultMode;
  switch (mode.mode) {
    case "FULL_NEXT":
      return advance.outstandingPaise;
    case "INSTALLMENTS": {
      const per = Math.ceil(advance.originalAmountPaise / mode.installments);
      return Math.min(per, advance.outstandingPaise);
    }
    case "FIXED_PER_MONTH":
      return mode.amountPaise;
    case "PERCENT_OF_NET":
      return pct(clampNonNegative(net), mode.percent);
    case "MANUAL":
    default:
      return 0;
  }
}

function describeRecovery(
  advance: AdvanceInput,
  policy: PayrollPolicy,
  wanted: Money,
  actual: Money,
): string {
  const mode = advance.recovery ?? policy.advance.defaultMode;
  const base = (() => {
    switch (mode.mode) {
      case "FULL_NEXT":
        return `full outstanding ${money(advance.outstandingPaise)}`;
      case "INSTALLMENTS":
        return `${money(advance.originalAmountPaise)} ÷ ${mode.installments} instalments`;
      case "FIXED_PER_MONTH":
        return `fixed ${money(mode.amountPaise)} per month`;
      case "PERCENT_OF_NET":
        return `${mode.percent}% of net`;
      case "MANUAL":
      default:
        return "manual recovery";
    }
  })();
  return actual < wanted ? `${base}, capped to keep net pay above the floor` : base;
}
