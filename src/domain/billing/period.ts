/**
 * Where a newly approved order's paid period starts.
 *
 * It started at the moment of approval, always. So a renewal approved with
 * three weeks still to run threw those three weeks away, and -- once a
 * confirmed order stopped expiring -- an old order approved after a newer one
 * would have cut a paid year short from that day. A payment buys time *after*
 * the time already paid for: the new period begins where the current paid one
 * ends, or now if nothing is running.
 *
 * Trials and free plans do not carry forward: the paid period starts at
 * approval, which is what the customer expects when they pay to leave a trial.
 */
export interface RunningPeriod {
  billingMode: string;
  status: string;
  currentPeriodEnd: Date | null;
}

export function paidPeriodStart(existing: RunningPeriod | null, now: Date): Date {
  if (!existing) return now;
  const running =
    existing.billingMode === "PAID" &&
    existing.status === "ACTIVE" &&
    existing.currentPeriodEnd != null &&
    existing.currentPeriodEnd.getTime() > now.getTime();
  return running ? (existing.currentPeriodEnd as Date) : now;
}

export function paidPeriodEnd(start: Date, months: number): Date {
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  return end;
}
