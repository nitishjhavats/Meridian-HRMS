/**
 * Analysing a proposed payroll policy before anyone activates it.
 *
 * The AI's job is to turn a sentence into structured rules. This module's job is
 * to be sceptical about the result: what actually changed, what the model must
 * have assumed, what contradicts itself, and what would quietly cost people
 * money. None of it depends on the AI — the same analysis runs when an admin
 * edits the policy by hand, which is the point.
 *
 * Pure, so every judgement below is testable without a network call.
 */

import { formatPaise } from "../money";
import type { PayrollPolicy, SalaryComponent } from "./types";

export type FindingSeverity =
  /** Will produce a wrong or unpayable result. Activation should be refused. */
  | "BLOCKER"
  /** Legal, but likely not what was meant. Worth a human look. */
  | "WARNING"
  /** A choice the model made that nobody stated. */
  | "ASSUMPTION"
  /** A plain description of what changed. */
  | "CHANGE";

export interface Finding {
  severity: FindingSeverity;
  /** Which part of the policy this is about. */
  area: string;
  message: string;
  /** How to fix it, when there is an obvious answer. */
  suggestion?: string;
}

export interface PolicyAnalysis {
  findings: Finding[];
  blockers: Finding[];
  /** Safe to offer an "activate" button. */
  activatable: boolean;
}

const pct = (n: number) => `${n}%`;

// ------------------------------------------------------------------ internal checks

/** Contradictions and mistakes visible in the policy on its own. */
function checkInternalConsistency(policy: PayrollPolicy): Finding[] {
  const findings: Finding[] = [];
  const a = policy.attendance;

  if (a.halfDayFactor <= 0 || a.halfDayFactor > 1) {
    findings.push({
      severity: "BLOCKER",
      area: "Attendance",
      message: `A half day is worth ${a.halfDayFactor} of a day, which is not a fraction of one.`,
      suggestion: "Set it to 0.5 unless the organisation genuinely pays half days differently.",
    });
  }

  // Overtime that pays less than ordinary time is almost always a mistake.
  if (policy.overtime.enabled && policy.overtime.rate.type === "MULTIPLIER") {
    const value = policy.overtime.rate.value;
    if (value < 1) {
      findings.push({
        severity: "WARNING",
        area: "Overtime",
        message: `Overtime is paid at ${value}× — less than ordinary hours.`,
        suggestion: "Most organisations use 1×, 1.5× or 2×.",
      });
    }
    if (value > 3) {
      findings.push({
        severity: "WARNING",
        area: "Overtime",
        message: `Overtime is paid at ${value}×, which is unusually generous.`,
      });
    }
  }

  if (policy.overtime.enabled && policy.overtime.maxPayableMinutesPerMonth === 0) {
    findings.push({
      severity: "ASSUMPTION",
      area: "Overtime",
      message: "Overtime is uncapped, so a single month could add an unbounded amount to payroll.",
      suggestion: "Consider a monthly cap.",
    });
  }

  // Late rules that can never fire.
  if (a.late.type === "PER_OCCURRENCE" && a.late.amountPaise === 0) {
    findings.push({
      severity: "WARNING",
      area: "Late arrivals",
      message: "A per-occurrence late penalty of zero has no effect.",
      suggestion: "Set an amount, or switch the rule to None.",
    });
  }
  if (a.late.type === "HALF_DAY_PER_N" && a.late.n > 15) {
    findings.push({
      severity: "WARNING",
      area: "Late arrivals",
      message: `Half a day is deducted only after ${a.late.n} late arrivals, which will rarely trigger in a month.`,
    });
  }

  if (a.absent.type === "MULTIPLIER" && a.absent.multiplier > 2) {
    findings.push({
      severity: "WARNING",
      area: "Absence",
      message: `An absent day costs ${a.absent.multiplier}× a day's pay.`,
      suggestion: "Check this is intended — it may exceed what local law allows.",
    });
  }

  // Unpaid week-offs are legal in some arrangements but catch people out.
  if (!policy.leave.weekOffPayable) {
    findings.push({
      severity: "WARNING",
      area: "Leave",
      message: "Week-offs are unpaid, so a monthly salary will be reduced for every rest day.",
      suggestion: "This is right for daily-wage staff and wrong for salaried staff.",
    });
  }
  if (!policy.leave.holidayPayable) {
    findings.push({
      severity: "WARNING",
      area: "Leave",
      message: "Public holidays are unpaid under this policy.",
    });
  }

  if (policy.advance.minNetPayPaise > 0) {
    findings.push({
      severity: "ASSUMPTION",
      area: "Advances",
      message: `Advance recovery stops once net pay would fall below ${formatPaise(policy.advance.minNetPayPaise)}.`,
    });
  }

  // A comp-off rule that points at a leave type nobody has.
  if (policy.extraDay.mode === "COMP_OFF" && !policy.extraDay.leaveTypeCode.trim()) {
    findings.push({
      severity: "BLOCKER",
      area: "Extra days",
      message: "Extra days are meant to grant compensatory off, but no leave type is named.",
      suggestion: "Name the comp-off leave type, or pay extra days in cash instead.",
    });
  }

  if (policy.rounding.mode !== "NONE" && policy.rounding.to > 10_000) {
    findings.push({
      severity: "WARNING",
      area: "Rounding",
      message: `Net pay is rounded to the nearest ${formatPaise(policy.rounding.to)}, which can move a salary noticeably.`,
    });
  }

  return findings;
}

// ------------------------------------------------------------------ components

function checkComponents(components: SalaryComponent[]): Finding[] {
  const findings: Finding[] = [];
  const earnings = components.filter((c) => c.kind === "EARNING");
  const hasBalance = earnings.some((c) => c.calc.type === "BALANCE");

  const percentTotal = earnings.reduce(
    (sum, c) => (c.calc.type === "PERCENT_OF_CTC" ? sum + c.calc.percent : sum),
    0,
  );
  const rounded = Math.round(percentTotal * 1000) / 1000;

  if (!hasBalance && rounded !== 100) {
    findings.push({
      severity: "BLOCKER",
      area: "Salary structure",
      message: `Percentage components total ${pct(rounded)}, not 100%.`,
      suggestion:
        rounded < 100
          ? `Add ${pct(100 - rounded)} somewhere, or make one component absorb the balance.`
          : `Remove ${pct(rounded - 100)} from the split.`,
    });
  }

  // Every component prorated by attendance means a single absent day reduces
  // even fixed reimbursements — usually not intended.
  const nonProrated = earnings.filter((c) => !c.prorated);
  if (earnings.length > 1 && nonProrated.length === 0) {
    findings.push({
      severity: "ASSUMPTION",
      area: "Salary structure",
      message: "Every component is reduced by attendance, including allowances.",
      suggestion: "Fixed reimbursements are usually not prorated.",
    });
  }

  if (earnings.length === 1 && earnings[0]?.code === "BASIC") {
    findings.push({
      severity: "ASSUMPTION",
      area: "Salary structure",
      message: "The whole salary sits in Basic, with no HRA or allowance split.",
      suggestion: "That is valid, but it raises the base for anything calculated on Basic.",
    });
  }

  return findings;
}

// ------------------------------------------------------------------ diff

/** What changed against the policy currently in force. */
function describeChanges(current: PayrollPolicy, proposed: PayrollPolicy): Finding[] {
  const findings: Finding[] = [];
  const change = (area: string, message: string) =>
    findings.push({ severity: "CHANGE" as const, area, message });

  if (current.payableDaysBasis !== proposed.payableDaysBasis) {
    change(
      "Payable days",
      `Basis changes from ${current.payableDaysBasis.replaceAll("_", " ").toLowerCase()} to ${proposed.payableDaysBasis.replaceAll("_", " ").toLowerCase()}.`,
    );
  }

  if (current.attendance.late.type !== proposed.attendance.late.type) {
    change(
      "Late arrivals",
      `Rule changes from ${current.attendance.late.type.replaceAll("_", " ").toLowerCase()} to ${proposed.attendance.late.type.replaceAll("_", " ").toLowerCase()}.`,
    );
  }

  if (current.extraDay.mode !== proposed.extraDay.mode) {
    change(
      "Extra days",
      `Work on a rest day changes from ${current.extraDay.mode.replaceAll("_", " ").toLowerCase()} to ${proposed.extraDay.mode.replaceAll("_", " ").toLowerCase()}.`,
    );
  } else if (
    current.extraDay.mode === "MULTIPLIER" &&
    proposed.extraDay.mode === "MULTIPLIER" &&
    current.extraDay.multiplier !== proposed.extraDay.multiplier
  ) {
    change(
      "Extra days",
      `Extra-day pay changes from ${current.extraDay.multiplier}× to ${proposed.extraDay.multiplier}×.`,
    );
  }

  if (current.overtime.enabled !== proposed.overtime.enabled) {
    change("Overtime", proposed.overtime.enabled ? "Overtime is switched on." : "Overtime is switched off.");
  }

  const currentCodes = new Set(current.components.map((c) => c.code));
  const proposedCodes = new Set(proposed.components.map((c) => c.code));
  const added = [...proposedCodes].filter((c) => !currentCodes.has(c));
  const removed = [...currentCodes].filter((c) => !proposedCodes.has(c));

  if (added.length > 0) change("Salary structure", `New components: ${added.join(", ")}.`);
  if (removed.length > 0) {
    findings.push({
      severity: "WARNING",
      area: "Salary structure",
      message: `Components removed: ${removed.join(", ")}. Existing salary profiles referencing them will lose that line.`,
    });
  }

  for (const component of proposed.components) {
    const before = current.components.find((c) => c.code === component.code);
    if (!before) continue;
    if (
      before.calc.type === "PERCENT_OF_CTC" &&
      component.calc.type === "PERCENT_OF_CTC" &&
      before.calc.percent !== component.calc.percent
    ) {
      change(
        "Salary structure",
        `${component.name}: ${pct(before.calc.percent)} → ${pct(component.calc.percent)}.`,
      );
    }
  }

  return findings;
}

// ------------------------------------------------------------------ entry point

export function analyzePolicy(
  proposed: PayrollPolicy,
  current?: PayrollPolicy | null,
): PolicyAnalysis {
  const findings = [
    ...checkInternalConsistency(proposed),
    ...checkComponents(proposed.components),
    ...(current ? describeChanges(current, proposed) : []),
  ];

  // Blockers first, then warnings, then assumptions, then plain changes —
  // an admin reading top-down sees what must be fixed before what merely
  // deserves a glance.
  const order: FindingSeverity[] = ["BLOCKER", "WARNING", "ASSUMPTION", "CHANGE"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  const blockers = findings.filter((f) => f.severity === "BLOCKER");

  return { findings, blockers, activatable: blockers.length === 0 };
}

/**
 * A plain-English restatement of the rules, so an admin can check the model
 * understood them without reading JSON.
 */
export function describePolicy(policy: PayrollPolicy): string[] {
  const lines: string[] = [];
  const a = policy.attendance;

  const basis = {
    CALENDAR_DAYS: "the number of days in the month",
    FIXED_30: "a fixed 30 days",
    WORKING_DAYS: "working days only",
    WORKING_DAYS_PLUS_PAID_OFF: "working days plus paid rest days",
  }[policy.payableDaysBasis];
  lines.push(`Salary is divided by ${basis}.`);

  const earnings = policy.components.filter((c) => c.kind === "EARNING");
  lines.push(
    `Salary splits into ${earnings
      .map((c) =>
        c.calc.type === "PERCENT_OF_CTC"
          ? `${c.name} ${pct(c.calc.percent)}`
          : c.calc.type === "FIXED"
            ? `${c.name} ${formatPaise(c.calc.amountPaise)}`
            : c.calc.type === "BALANCE"
              ? `${c.name} (the remainder)`
              : `${c.name} ${pct(c.calc.percent)} of ${c.calc.of}`,
      )
      .join(", ")}.`,
  );

  switch (a.late.type) {
    case "NONE":
      lines.push("Late arrivals are recorded but not deducted.");
      break;
    case "PER_OCCURRENCE":
      lines.push(
        `After ${a.late.freeCount} free late arrivals, each one costs ${formatPaise(a.late.amountPaise)}.`,
      );
      break;
    case "HALF_DAY_PER_N":
      lines.push(
        `After ${a.late.freeCount} free late arrivals, every ${a.late.n} lates cost half a day's pay.`,
      );
      break;
    case "PRORATA_MINUTES":
      lines.push(
        `Late minutes beyond ${a.late.freeMinutes} are deducted at the per-minute rate.`,
      );
      break;
  }

  switch (policy.extraDay.mode) {
    case "NORMAL_DAY":
      lines.push("Working a rest day earns nothing extra — the day was already paid.");
      break;
    case "MULTIPLIER":
      lines.push(
        `Working a rest day earns ${policy.extraDay.multiplier}× a day's pay on top of the rest day itself.`,
      );
      break;
    case "OVERTIME_RATE":
      lines.push("Working a rest day is paid through overtime hours.");
      break;
    case "COMP_OFF":
      lines.push(
        `Working a rest day grants ${policy.extraDay.daysPerExtraDay} day(s) of ${policy.extraDay.leaveTypeCode} instead of cash.`,
      );
      break;
  }

  if (policy.overtime.enabled) {
    lines.push(
      policy.overtime.rate.type === "MULTIPLIER"
        ? `Overtime is paid at ${policy.overtime.rate.value}× the hourly rate.`
        : `Overtime is paid at ${formatPaise(policy.overtime.rate.amountPaise)} per hour.`,
    );
  } else {
    lines.push("Overtime is not paid.");
  }

  lines.push(
    policy.leave.weekOffPayable ? "Week-offs are paid." : "Week-offs are unpaid.",
    policy.leave.holidayPayable ? "Public holidays are paid." : "Public holidays are unpaid.",
  );

  if (policy.weekOff.quotaPerMonth !== null) {
    lines.push(
      `Everybody is owed ${policy.weekOff.quotaPerMonth} week off(s) a month, ${
        policy.weekOff.paid ? "paid" : "unpaid"
      }.`,
    );
  }

  if (policy.weekOff.payUnused.enabled) {
    const rate = policy.weekOff.payUnused.rate;
    lines.push(
      rate.type === "MULTIPLIER"
        ? `A week off owed and not taken is paid at ${rate.value}x a day's salary.`
        : rate.type === "OVERTIME_RATE"
          ? "A week off owed and not taken is paid at the overtime rate for a standard day."
          : "A week off owed and not taken is paid as one day's salary.",
    );
    if (!policy.weekOff.paid) {
      // Said plainly rather than left for somebody to discover on a payslip:
      // the engine will not pay cash for an entitlement that was never paid.
      lines.push("It will not be paid, though, because week offs are unpaid here.");
    }
  }

  if (policy.rounding.mode !== "NONE") {
    lines.push(
      `Net pay is rounded ${policy.rounding.mode.toLowerCase()} to ${formatPaise(policy.rounding.to)}.`,
    );
  }

  return lines;
}
