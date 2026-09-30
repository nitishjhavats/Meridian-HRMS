/**
 * Payroll rule simulator (spec §27).
 *
 * Lets an admin type a hypothetical employee — "₹50,000, 25 days present, 3
 * lates, 1 half day, 4 hours overtime, ₹5,000 advance" — and see the exact
 * calculation their policy would produce, before it touches a real payslip.
 *
 * Pure: no database, no employee record, no writes.
 */

import { daysInMonth, endOfMonth, startOfMonth, addDays } from "../date";
import { calculatePayroll } from "./engine";
import type {
  AdjustmentInput,
  AdvanceRecoveryMode,
  DayLedgerEntry,
  PayrollInput,
  PayrollPolicy,
  PayrollResult,
  SalaryComponent,
} from "./types";

export interface SimulationInput {
  ctcMonthlyPaise: number;
  year: number;
  month: number;

  /** Calendar shape. Anything omitted is derived from the month. */
  weekOffDays?: number;
  holidayDays?: number;
  paidHolidayDays?: number;

  /** Attendance shape. */
  presentDays: number;
  halfDays?: number;
  absentDays?: number;
  paidLeaveDays?: number;
  unpaidLeaveDays?: number;
  extraDays?: number;

  lateCount?: number;
  lateMinutesEach?: number;
  earlyLeaveCount?: number;
  earlyLeaveMinutesEach?: number;
  overtimeMinutes?: number;

  advancePaise?: number;
  advanceRecovery?: AdvanceRecoveryMode;
  adjustments?: AdjustmentInput[];

  training?: { mode: "PERCENT" | "FIXED" | "UNPAID"; percent?: number; fixedAmountPaise?: number };
  componentOverrides?: SalaryComponent[] | null;
  /**
   * Rest days a month this hypothetical person is owed, over the payroll
   * rule's own figure. Left out or null, the engine asks the rule — the same
   * fallback a real run gets, so the sandbox cannot promise a credit the
   * payslip will not show.
   */
  weekOffQuota?: number | null;
}

export interface SimulationOutput {
  result: PayrollResult;
  /** The synthetic input the engine actually saw, so the UI can show its workings. */
  input: PayrollInput;
  /** Days the caller described that did not fit in the month. */
  unallocatedDays: number;
}

export class SimulationError extends Error {}

/**
 * Builds a synthetic month from the described counts and runs the real engine
 * over it — the simulator and production payroll share one code path, so a
 * simulation can never disagree with the payslip it is meant to predict.
 */
export function simulatePayroll(input: SimulationInput, policy: PayrollPolicy): SimulationOutput {
  if (input.month < 1 || input.month > 12) {
    throw new SimulationError("Month must be between 1 and 12.");
  }
  if (input.ctcMonthlyPaise < 0) {
    throw new SimulationError("Monthly salary cannot be negative.");
  }

  const totalDays = daysInMonth(input.year, input.month);
  const start = startOfMonth(input.year, input.month);
  const end = endOfMonth(input.year, input.month);

  const weekOffDays = input.weekOffDays ?? countSundays(input.year, input.month);
  const holidayDays = input.holidayDays ?? 0;
  const paidHolidayDays = input.paidHolidayDays ?? holidayDays;
  const workingDays = Math.max(0, totalDays - weekOffDays - holidayDays);

  const counts: Array<[DayLedgerEntry["status"], number]> = [
    ["FULL_DAY", Math.max(0, input.presentDays)],
    ["HALF_DAY", input.halfDays ?? 0],
    ["ABSENT", input.absentDays ?? 0],
    ["PAID_LEAVE", input.paidLeaveDays ?? 0],
    ["UNPAID_LEAVE", input.unpaidLeaveDays ?? 0],
    ["EXTRA_DAY", input.extraDays ?? 0],
    ["HOLIDAY", holidayDays],
    ["WEEK_OFF", Math.max(0, weekOffDays - (input.extraDays ?? 0))],
  ];

  const described = counts.reduce((acc, [, n]) => acc + n, 0);
  const unallocatedDays = Math.max(0, described - totalDays);

  const ledger: DayLedgerEntry[] = [];
  let cursor = start;
  for (const [status, count] of counts) {
    for (let i = 0; i < count && ledger.length < totalDays; i++) {
      ledger.push({
        date: cursor,
        status,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        isLate: false,
      });
      cursor = addDays(cursor, 1);
    }
  }

  // Spread the described lates / early departures / overtime over worked days.
  const workedDays = ledger.filter(
    (d) => d.status === "FULL_DAY" || d.status === "HALF_DAY" || d.status === "EXTRA_DAY",
  );
  const lateMinutesEach = input.lateMinutesEach ?? 20;
  for (let i = 0; i < (input.lateCount ?? 0) && i < workedDays.length; i++) {
    const day = workedDays[i];
    if (!day) break;
    day.isLate = true;
    day.lateMinutes = lateMinutesEach;
  }
  const earlyMinutesEach = input.earlyLeaveMinutesEach ?? 45;
  for (let i = 0; i < (input.earlyLeaveCount ?? 0) && i < workedDays.length; i++) {
    const day = workedDays[workedDays.length - 1 - i];
    if (!day) break;
    day.earlyLeaveMinutes = earlyMinutesEach;
  }
  if (input.overtimeMinutes && workedDays[0]) {
    workedDays[0].overtimeMinutes = input.overtimeMinutes;
  }

  const payrollInput: PayrollInput = {
    employee: {
      id: "simulated",
      code: "SIM-001",
      name: "Simulated employee",
      joinedOn: start,
    },
    period: { year: input.year, month: input.month, start, end },
    ctcMonthlyPaise: input.ctcMonthlyPaise,
    segments: input.training
      ? [
          {
            from: start,
            to: end,
            state: "TRAINING",
            ctcMonthlyPaise: input.ctcMonthlyPaise,
            training: input.training,
          },
        ]
      : [],
    calendar: { totalDays, workingDays, weekOffDays, holidayDays, paidHolidayDays },
    ledger,
    advances:
      input.advancePaise && input.advancePaise > 0
        ? [
            {
              id: "simulated-advance",
              outstandingPaise: input.advancePaise,
              originalAmountPaise: input.advancePaise,
              installmentsPaid: 0,
              recovery: input.advanceRecovery ?? policy.advance.defaultMode,
            },
          ]
        : [],
    adjustments: input.adjustments ?? [],
    componentOverrides: input.componentOverrides ?? null,
    weekOffQuota: input.weekOffQuota ?? null,
  };

  return { result: calculatePayroll(payrollInput, policy), input: payrollInput, unallocatedDays };
}

function countSundays(year: number, month: number): number {
  const total = daysInMonth(year, month);
  let count = 0;
  for (let day = 1; day <= total; day++) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) count++;
  }
  return count;
}

/** A few ready-made scenarios so the simulator screen is useful on first open. */
export const SIMULATION_PRESETS: { name: string; description: string; input: Omit<SimulationInput, "year" | "month"> }[] = [
  {
    name: "Perfect month",
    description: "Full attendance, nothing unusual",
    input: { ctcMonthlyPaise: 5_000_000, presentDays: 26 },
  },
  {
    name: "Spec example",
    description: "₹50,000 · 25 days · 3 lates · 1 half day · 4 h overtime · ₹5,000 advance",
    input: {
      ctcMonthlyPaise: 5_000_000,
      presentDays: 25,
      halfDays: 1,
      lateCount: 3,
      overtimeMinutes: 240,
      advancePaise: 500_000,
    },
  },
  {
    name: "Trainee",
    description: "Training at 70 % of ₹30,000",
    input: {
      ctcMonthlyPaise: 3_000_000,
      presentDays: 26,
      training: { mode: "PERCENT", percent: 70 },
    },
  },
  {
    name: "Worked a week off",
    description: "Full month plus one extra day",
    input: { ctcMonthlyPaise: 3_000_000, presentDays: 26, extraDays: 1 },
  },
];
