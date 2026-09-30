/**
 * Payment order state machine.
 *
 * Transitions are the only way an order's status changes, so the 4-hour window,
 * the two confirmation modes and idempotent approval are all enforced in one
 * pure place that can be tested without a database.
 *
 *                  ┌─────────────┐
 *   create ───────►│  INITIATED  │  amount frozen, expiresAt = now + window
 *                  └──────┬──────┘
 *      "I have paid" (UTR or issued code)
 *                         ▼
 *                  ┌──────────────────────┐
 *                  │ AWAITING_CONFIRMATION│──── reject ──► REJECTED (terminal)
 *                  └──┬────────────────┬──┘
 *            approve  │                │ request info
 *                     ▼                ▼
 *                ┌──────────┐   ┌────────────────┐
 *                │ APPROVED │   │ INFO_REQUESTED │──(resubmit)──► AWAITING_CONFIRMATION
 *                └──────────┘   └────────────────┘
 *
 *   INITIATED with nothing said by expiresAt ──► EXPIRED (terminal)
 *
 * The window is the organisation's deadline to say "I have paid", and only
 * that. Once it has said so the order is waiting on the platform, and a
 * reviewer's slow afternoon must not turn a customer's transferred money into
 * an order nobody can approve -- so the clock runs in INITIATED and nowhere
 * else. An order the platform has asked a question about (INFO_REQUESTED) is
 * off the clock too: the reviewer can reject it if the answer never comes.
 */

export type OrderStatus =
  | "INITIATED"
  | "AWAITING_CONFIRMATION"
  | "INFO_REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED";

export type OrderAction =
  /** Organisation submits a UTR/reference (mode UTR). */
  | { type: "SUBMIT_REFERENCE"; reference: string; note?: string }
  /**
   * Nothing was owed, so nothing was paid.
   *
   * Its own action rather than a reference with a made-up value in it. A
   * reference is a claim -- "this is the transaction, go and look it up" -- and
   * inventing one for a bill of zero would put a number on the record that no
   * bank has ever heard of. This says what actually happened.
   *
   * Allowed in every confirmation mode, because neither mode applies: there is
   * no UTR to quote and no code to issue for an amount nobody will transfer.
   * Whether the amount really is zero is not the machine's to know -- the
   * caller checks the order, and that check is the whole authorisation.
   */
  | { type: "SUBMIT_NOTHING_DUE" }
  /**
   * A code the platform owner made in advance, before this order existed.
   *
   * Not `SUBMIT_CODE`, which checks the order's own issued code and counts
   * attempts against it; there is no issued code on the order for this one.
   * Whether the typed code exists, is live, and belongs to this organisation
   * is the caller's to decide -- it needs a lookup the machine does not have
   * -- and by the time this action arrives that has been settled. Allowed in
   * every confirmation mode: the code is the owner's choice, and the mode is
   * about what the organisation may do on its own.
   */
  | { type: "SUBMIT_ADVANCE_CODE"; code: string }
  /** Superadmin issues a confirmation code for the organisation to enter (mode CODE). */
  | { type: "ISSUE_CODE"; actorId: string }
  /** Organisation enters the issued code (mode CODE). */
  | { type: "SUBMIT_CODE"; code: string }
  | { type: "APPROVE"; actorId: string; note?: string }
  | { type: "REJECT"; actorId: string; note: string }
  | { type: "REQUEST_INFO"; actorId: string; note: string }
  | { type: "RESUBMIT"; reference?: string; note?: string }
  | { type: "EXPIRE" };

export type ConfirmationMode = "UTR" | "CODE" | "BOTH";

export interface OrderState {
  status: OrderStatus;
  expiresAt: Date;
  /** Set once a code has been issued (mode CODE). */
  issuedCodeHash: string | null;
  codeAttemptCount: number;
  confirmationCode: string | null;
  transactionRef: string | null;
}

export interface TransitionContext {
  now: Date;
  mode: ConfirmationMode;
  /** Compares a submitted code with `issuedCodeHash`. Injected so hashing stays in lib/. */
  verifyCode?: (plaintext: string, hash: string) => boolean;
  maxCodeAttempts?: number;
}

export type TransitionFailure =
  | "EXPIRED"
  | "TERMINAL"
  | "ILLEGAL_TRANSITION"
  | "MODE_NOT_ALLOWED"
  | "CODE_NOT_ISSUED"
  | "CODE_MISMATCH"
  | "TOO_MANY_ATTEMPTS"
  | "REFERENCE_REQUIRED";

export interface TransitionResult {
  ok: boolean;
  next?: OrderState;
  failure?: TransitionFailure;
  message?: string;
  /** True when the action was a no-op because the order is already in the target state. */
  idempotent?: boolean;
}

const TERMINAL: readonly OrderStatus[] = ["APPROVED", "REJECTED", "EXPIRED"];

const FAILURE_MESSAGES: Record<TransitionFailure, string> = {
  EXPIRED: "This payment request has expired. Please start a new one.",
  TERMINAL: "This payment request has already been closed.",
  ILLEGAL_TRANSITION: "That action is not available for this payment request.",
  MODE_NOT_ALLOWED: "That confirmation method is not enabled.",
  CODE_NOT_ISSUED: "No confirmation code has been issued for this request yet.",
  CODE_MISMATCH: "That confirmation code is not correct.",
  TOO_MANY_ATTEMPTS: "Too many incorrect codes. Ask the administrator to issue a new one.",
  REFERENCE_REQUIRED: "A payment reference is required.",
};

/**
 * Is the confirmation window running? Only while the organisation still owes
 * a confirmation. After "I have paid" the order belongs to the reviewer, and
 * an order does not lapse because the reviewer was slow.
 */
export function clockRunning(status: OrderStatus): boolean {
  return status === "INITIATED";
}

export function isExpired(state: OrderState, now: Date): boolean {
  return clockRunning(state.status) && now >= state.expiresAt;
}

/**
 * Minutes left in the confirmation window; 0 once it has run out or the order
 * is closed. An order that is waiting on the platform has no deadline, and
 * says so with `Infinity` rather than 0: every caller reads "more than zero"
 * as "still live", and a confirmed order past its original window is exactly
 * that. `Number.isFinite` tells a countdown from a request with no clock.
 */
export function minutesRemaining(state: OrderState, now: Date): number {
  if (TERMINAL.includes(state.status)) return 0;
  if (!clockRunning(state.status)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil((state.expiresAt.getTime() - now.getTime()) / 60_000));
}

export function expiresAtFrom(createdAt: Date, windowMinutes: number): Date {
  return new Date(createdAt.getTime() + windowMinutes * 60_000);
}

function fail(failure: TransitionFailure): TransitionResult {
  return { ok: false, failure, message: FAILURE_MESSAGES[failure] };
}

export function transition(
  state: OrderState,
  action: OrderAction,
  ctx: TransitionContext,
): TransitionResult {
  // Approving twice is a no-op rather than an error, so a double-clicked
  // approval button cannot credit seats twice.
  if (state.status === "APPROVED" && action.type === "APPROVE") {
    return { ok: true, next: state, idempotent: true };
  }
  if (TERMINAL.includes(state.status)) {
    return fail(state.status === "EXPIRED" ? "EXPIRED" : "TERMINAL");
  }

  // Expiry is evaluated on every read *and* every write, so a stale row can never
  // be confirmed even if the sweep job has not run. Only an INITIATED order can
  // be stale (see `clockRunning`); a confirmed one is the reviewer's to close.
  if (action.type !== "EXPIRE" && isExpired(state, ctx.now)) {
    return { ok: false, failure: "EXPIRED", message: FAILURE_MESSAGES.EXPIRED, next: { ...state, status: "EXPIRED" } };
  }

  switch (action.type) {
    case "SUBMIT_REFERENCE": {
      if (ctx.mode === "CODE") return fail("MODE_NOT_ALLOWED");
      if (state.status !== "INITIATED" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      if (!action.reference.trim()) return fail("REFERENCE_REQUIRED");
      return {
        ok: true,
        next: {
          ...state,
          status: "AWAITING_CONFIRMATION",
          transactionRef: action.reference.trim(),
          confirmationCode: action.reference.trim(),
        },
      };
    }

    case "SUBMIT_NOTHING_DUE": {
      if (state.status !== "INITIATED" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      return {
        ok: true,
        next: {
          ...state,
          status: "AWAITING_CONFIRMATION",
          // Deliberately left empty. The order summary prints `transactionRef`
          // as "Your reference", and there is no reference; a placeholder there
          // would read as one.
          transactionRef: null,
          confirmationCode: null,
        },
      };
    }

    case "SUBMIT_ADVANCE_CODE": {
      if (state.status !== "INITIATED" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      // The typed code is kept as the confirmation, the way an issued code is,
      // so the owner's queue shows what was entered rather than a blank.
      return {
        ok: true,
        next: { ...state, status: "AWAITING_CONFIRMATION", confirmationCode: action.code },
      };
    }

    case "ISSUE_CODE": {
      if (ctx.mode === "UTR") return fail("MODE_NOT_ALLOWED");
      if (state.status !== "INITIATED" && state.status !== "AWAITING_CONFIRMATION" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      // The caller generates and hashes the code; the machine only records that
      // one now exists and resets the attempt counter.
      return { ok: true, next: { ...state, codeAttemptCount: 0 } };
    }

    case "SUBMIT_CODE": {
      if (ctx.mode === "UTR") return fail("MODE_NOT_ALLOWED");
      if (!state.issuedCodeHash) return fail("CODE_NOT_ISSUED");
      const maxAttempts = ctx.maxCodeAttempts ?? 5;
      if (state.codeAttemptCount >= maxAttempts) return fail("TOO_MANY_ATTEMPTS");

      const matches = ctx.verifyCode?.(action.code, state.issuedCodeHash) ?? false;
      if (!matches) {
        return {
          ok: false,
          failure: "CODE_MISMATCH",
          message: FAILURE_MESSAGES.CODE_MISMATCH,
          next: { ...state, codeAttemptCount: state.codeAttemptCount + 1 },
        };
      }
      // A correct code is the organisation's half of the handshake; the
      // superadmin still has to approve, which is what credits the seats.
      return {
        ok: true,
        next: { ...state, status: "AWAITING_CONFIRMATION", confirmationCode: action.code },
      };
    }

    case "APPROVE": {
      if (state.status !== "AWAITING_CONFIRMATION" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      return { ok: true, next: { ...state, status: "APPROVED" } };
    }

    case "REJECT": {
      if (state.status !== "AWAITING_CONFIRMATION" && state.status !== "INFO_REQUESTED") {
        return fail("ILLEGAL_TRANSITION");
      }
      return { ok: true, next: { ...state, status: "REJECTED" } };
    }

    case "REQUEST_INFO": {
      if (state.status !== "AWAITING_CONFIRMATION") return fail("ILLEGAL_TRANSITION");
      return { ok: true, next: { ...state, status: "INFO_REQUESTED" } };
    }

    case "RESUBMIT": {
      if (state.status !== "INFO_REQUESTED") return fail("ILLEGAL_TRANSITION");
      return {
        ok: true,
        next: {
          ...state,
          status: "AWAITING_CONFIRMATION",
          transactionRef: action.reference?.trim() ?? state.transactionRef,
        },
      };
    }

    case "EXPIRE": {
      if (!isExpired(state, ctx.now)) return fail("ILLEGAL_TRANSITION");
      return { ok: true, next: { ...state, status: "EXPIRED" } };
    }

    default:
      return fail("ILLEGAL_TRANSITION");
  }
}

/** Which actions the given viewer can take right now — drives button state in the UI. */
export function availableActions(
  state: OrderState,
  ctx: TransitionContext,
  viewer: "ORG" | "SUPERADMIN",
): OrderAction["type"][] {
  if (TERMINAL.includes(state.status) || isExpired(state, ctx.now)) return [];

  if (viewer === "ORG") {
    const actions: OrderAction["type"][] = [];
    if (ctx.mode !== "CODE" && (state.status === "INITIATED" || state.status === "INFO_REQUESTED")) {
      actions.push("SUBMIT_REFERENCE");
    }
    if (ctx.mode !== "UTR" && state.issuedCodeHash) actions.push("SUBMIT_CODE");
    if (state.status === "INITIATED" || state.status === "INFO_REQUESTED") {
      actions.push("SUBMIT_ADVANCE_CODE");
    }
    if (state.status === "INFO_REQUESTED") actions.push("RESUBMIT");
    return actions;
  }

  const actions: OrderAction["type"][] = [];
  if (ctx.mode !== "UTR") actions.push("ISSUE_CODE");
  if (state.status === "AWAITING_CONFIRMATION" || state.status === "INFO_REQUESTED") {
    actions.push("APPROVE", "REJECT");
  }
  if (state.status === "AWAITING_CONFIRMATION") actions.push("REQUEST_INFO");
  return actions;
}
