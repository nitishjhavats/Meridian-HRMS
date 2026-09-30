/**
 * Seat accounting.
 *
 * A seat is consumed by an **active employee** — `Resigned`, `Terminated` and
 * `Inactive` people are free. That means seat usage moves whenever an employment
 * state changes, so the check lives here and is called from the employee service
 * inside the same transaction that flips the state.
 */

export type BillingMode = "TRIAL" | "PAID" | "FREE_INTERNAL";

export type BillableState =
  | "TRAINING"
  | "PROBATION"
  | "REGULAR"
  | "CONFIRMED"
  | "NOTICE_PERIOD"
  | "RESIGNED"
  | "TERMINATED"
  | "INACTIVE";

/** States that consume a paid seat. Someone serving notice is still working. */
export const BILLABLE_STATES: readonly BillableState[] = [
  "TRAINING",
  "PROBATION",
  "REGULAR",
  "CONFIRMED",
  "NOTICE_PERIOD",
];

export function isBillable(state: BillableState, active: boolean): boolean {
  return active && BILLABLE_STATES.includes(state);
}

export interface SeatContext {
  activeEmployees: number;
  seats: number;
  billingMode: BillingMode;
  /** Overage tolerated until this instant, if the platform allows a grace period. */
  graceUntil?: Date | null;
  now: Date;
}

export type SeatRejection = "SEAT_LIMIT_REACHED" | "SUBSCRIPTION_INACTIVE";

export interface SeatDecision {
  allowed: boolean;
  reason?: SeatRejection;
  message?: string;
  seatsRemaining: number;
  overage: number;
}

/**
 * Can one more employee be made active?
 *
 * Free/internal organisations are unmetered. Everyone else is blocked at the
 * limit with a clear message, because silently exceeding a paid seat count is
 * how a SaaS leaks revenue and how a customer gets a surprise bill.
 */
export function canActivateEmployee(ctx: SeatContext): SeatDecision {
  const seatsRemaining = Math.max(0, ctx.seats - ctx.activeEmployees);
  const overage = Math.max(0, ctx.activeEmployees - ctx.seats);

  if (ctx.billingMode === "FREE_INTERNAL") {
    return { allowed: true, seatsRemaining: Number.POSITIVE_INFINITY, overage: 0 };
  }

  if (ctx.activeEmployees < ctx.seats) {
    return { allowed: true, seatsRemaining, overage };
  }

  if (ctx.graceUntil && ctx.now < ctx.graceUntil) {
    return { allowed: true, seatsRemaining: 0, overage: overage + 1 };
  }

  return {
    allowed: false,
    reason: "SEAT_LIMIT_REACHED",
    message:
      ctx.seats === 0
        ? "No seats have been purchased yet. Add seats to start adding employees."
        : `All ${ctx.seats} seats are in use. Add seats to activate another employee.`,
    seatsRemaining: 0,
    overage,
  };
}

export interface SeatSummary {
  seats: number;
  used: number;
  remaining: number;
  overage: number;
  utilisationPercent: number;
}

export function summariseSeats(seats: number, activeEmployees: number): SeatSummary {
  return {
    seats,
    used: activeEmployees,
    remaining: Math.max(0, seats - activeEmployees),
    overage: Math.max(0, activeEmployees - seats),
    utilisationPercent: seats <= 0 ? 0 : Math.round((activeEmployees / seats) * 100),
  };
}

/** Mirrors Prisma's `SubscriptionStatus`, kept here so the domain stays free of the client. */
export type SubscriptionStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "EXPIRED";

export interface SubscriptionWindow {
  billingMode: BillingMode;
  currentPeriodEnd: Date;
  trialEndsAt?: Date | null;
  /**
   * Required rather than optional on purpose. A caller that forgets it would
   * silently get the date-only answer, and that answer is wrong for exactly
   * the organisations this field exists for (see `resolveAccessState`).
   */
  status: SubscriptionStatus;
}

export type AccessState = "ACTIVE" | "TRIAL" | "TRIAL_EXPIRED" | "PAST_DUE" | "UNMETERED";

/**
 * What an organisation may do right now. `TRIAL_EXPIRED` and `PAST_DUE` put the
 * app into read-only mode rather than logging people out — an admin still needs
 * to reach the payment screen.
 *
 * A paying organisation is past due on either of two grounds: its period has
 * ended, or the platform has marked it so. The second is not redundant. An
 * organisation created as PAID without "already paid" is written with a full
 * period ahead of it and `PAST_DUE` on the row, and the owner is told it cannot
 * be used until a payment is approved; judged by the date alone it had a whole
 * cycle of full access without anybody paying. Approval flips the row to
 * `ACTIVE`, as does the "Paid up" switch on the platform, so the mark is only
 * ever there while somebody has said the money has not arrived.
 */
export function resolveAccessState(sub: SubscriptionWindow, now: Date): AccessState {
  if (sub.billingMode === "FREE_INTERNAL") return "UNMETERED";
  if (sub.billingMode === "TRIAL") {
    const ends = sub.trialEndsAt ?? sub.currentPeriodEnd;
    return now <= ends ? "TRIAL" : "TRIAL_EXPIRED";
  }
  // Only the mark the product actually writes. `SUSPENDED` and `EXPIRED` exist
  // on the enum and nothing sets them; reading them here would be a rule
  // nobody chose, and one that could shut a live organisation out on deploy.
  if (sub.status === "PAST_DUE") return "PAST_DUE";
  return now <= sub.currentPeriodEnd ? "ACTIVE" : "PAST_DUE";
}

export function isReadOnly(state: AccessState): boolean {
  return state === "TRIAL_EXPIRED" || state === "PAST_DUE";
}
