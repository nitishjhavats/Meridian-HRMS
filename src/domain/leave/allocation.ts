/**
 * How many days of a leave type one person gets.
 *
 * Three layers, and each is a different kind of statement:
 *
 *   - the **leave type** carries the company's answer;
 *   - a **designation** carries the job's answer, because a manager and a
 *     trainee do not get the same casual leave and writing that once per role
 *     is the difference between a policy somebody maintains and one they
 *     abandon;
 *   - **`LeaveBalance.allocated`** carries one person's, for the contract that
 *     says something different. It is the finest layer and wins over both.
 *
 * The nearest answer wins, and absent means "ask the layer above". Zero is a
 * real answer — a designation that genuinely gets no leave of this kind — so
 * this must never treat a stored 0 as "not set".
 *
 * Pure, and used by every reader of an allocation, because the balance service,
 * the accrual maths, the full-and-final settlement and the reports each work
 * this out and would otherwise disagree about the same employee. Before this
 * was wired through, the per-designation figure reached exactly one screen —
 * the one that edits it. Everywhere leave was actually accrued, spent, carried
 * forward or encashed read `LeaveType.annualAllocation`, so two people on
 * different designations were shown different entitlements and then paid out on
 * the same one.
 */

/** `leaveTypeId -> designationId -> days`. */
export type AllocationOverrides = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * One layer's stored answer, or `null` when that layer has nothing to say.
 *
 * The reason this exists rather than a bare `Number(...)` at each call site:
 * **`Number(null)` is 0**, and so is `Number("")`, and both are finite. A layer
 * that has not been set would therefore read as "this person gets zero days"
 * rather than "ask the layer above" — and the damage does not stop at a wrong
 * number on a screen. Zero days flows into the accrual cap, into the balance
 * the request form validates against, and into the encashment line of a
 * full-and-final settlement, which is money.
 *
 * A negative or unparseable figure is treated the same way, as nothing said: a
 * malformed row must fall back, never subtract.
 */
export function allocationDays(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // `Number(true)` is 1 and `Number([])` is 0. Neither is a day count anybody
  // typed, and both are finite enough to slip through the check below.
  if (typeof value === "boolean" || Array.isArray(value)) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

/**
 * The precedence, written down once.
 *
 * `personal` is `LeaveBalance.allocated` for the year, `designation` is the
 * `DesignationLeaveAllocation` row if there is one, `type` is
 * `LeaveType.annualAllocation`. Each may be a Prisma `Decimal`, a string, a
 * number, `null` or absent; `allocationDays` decides what counts as an answer.
 *
 * The final `?? 0` is only reachable when every layer is missing or malformed,
 * which means the leave type itself has no usable allocation. Zero is the
 * honest answer there — there is no number to fall back to.
 */
export function resolveAllocation(layers: {
  /** `LeaveBalance.allocated` — this person's own figure for the year. */
  personal?: unknown;
  /** The `DesignationLeaveAllocation` figure for their job, if one is set. */
  designation?: unknown;
  /** `LeaveType.annualAllocation` — the company's figure. */
  type?: unknown;
}): number {
  return (
    allocationDays(layers.personal) ??
    allocationDays(layers.designation) ??
    allocationDays(layers.type) ??
    0
  );
}

/**
 * The designation layer for one employee and one leave type, or `null` when
 * that role has no row — which is the ordinary case, since a row exists only
 * where somebody deliberately made an exception.
 *
 * Returning `null` rather than a number is the whole point: it is what lets
 * `resolveAllocation` tell "this role gets no leave of this type" apart from
 * "nobody has said anything about this role".
 */
export function designationAllocation(
  overrides: AllocationOverrides,
  leaveTypeId: string,
  designationId: string | null | undefined,
): number | null {
  if (!designationId) return null;
  return overrides.get(leaveTypeId)?.get(designationId) ?? null;
}

/**
 * The designation-and-type answer in one call, for readers that have no
 * personal layer to consider.
 *
 * A thin wrapper over `resolveAllocation` and deliberately not a second
 * implementation of the precedence.
 */
export function effectiveAllocation(
  input: {
    leaveTypeId: string;
    /** The leave type's own annual allocation. */
    typeDefault: number;
    /** The employee's designation, if they have one. */
    designationId: string | null | undefined;
  },
  overrides: AllocationOverrides,
): number {
  return resolveAllocation({
    designation: designationAllocation(overrides, input.leaveTypeId, input.designationId),
    type: input.typeDefault,
  });
}

/** Builds the lookup from rows, ready for `designationAllocation`. */
export function allocationOverrides(
  rows: readonly { leaveTypeId: string; designationId: string; annualAllocation: unknown }[],
): AllocationOverrides {
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    // A row whose allocation is not a usable number is dropped rather than
    // stored as zero — see `allocationDays`. Storing it would be the most
    // damaging way for this function to be wrong: everybody holding that
    // designation would silently lose the leave type entirely.
    const days = allocationDays(row.annualAllocation);
    if (days === null) continue;

    const forType = out.get(row.leaveTypeId) ?? new Map<string, number>();
    forType.set(row.designationId, days);
    out.set(row.leaveTypeId, forType);
  }
  return out;
}
