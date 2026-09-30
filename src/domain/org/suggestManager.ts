/**
 * Who the designation graph says should manage somebody.
 *
 * A suggestion, never a decision. The rule is deliberately narrow: the
 * candidates are the active people holding a designation that this person's
 * designation reports to. One candidate can be pre-selected; several must be
 * chosen between, because picking one of three Engineering Managers at random
 * hands somebody's leave approvals — and their pay-affecting attendance
 * corrections — to a stranger, and nobody notices for months.
 *
 * Pure, and it lives here rather than in the employee form because the backfill
 * script has to reach the same answer. A second copy of this rule that drifted
 * would put the bulk-assigned manager and the on-screen suggestion out of step,
 * which is precisely how "organisation default" came to mean three different
 * things to three readers of the weekly-off pattern.
 */

export interface ManagerCandidate {
  id: string;
  name: string;
  designationId: string | null;
}

export interface SuggestManagerInput {
  /** The designation of the person who needs a manager. */
  designationId: string | null | undefined;
  /** designationId → the designations it reports to. */
  designationParents: Record<string, string[] | undefined>;
  /** Everyone who could hold a line — already filtered to active people. */
  managers: ManagerCandidate[];
  /** Never suggest somebody as their own manager. */
  excludeEmployeeId?: string | null;
}

/**
 * Every candidate, in the order given. Empty when the person has no
 * designation, when that designation reports to nothing, or when nobody holds
 * the parent designation — all three of which mean "ask a human", not "guess".
 */
export function suggestManagers(input: SuggestManagerInput): ManagerCandidate[] {
  if (!input.designationId) return [];
  const parents = input.designationParents[input.designationId] ?? [];
  if (parents.length === 0) return [];
  return input.managers.filter(
    (m) =>
      m.designationId !== null &&
      m.designationId !== undefined &&
      parents.includes(m.designationId) &&
      m.id !== input.excludeEmployeeId,
  );
}

/**
 * The one candidate to act on, or null.
 *
 * Null for zero *and* for several. The caller has to tell the difference to
 * write honest copy, so it calls `suggestManagers` for the count; this exists so
 * no caller can quietly turn "three possible managers" into "the first one".
 */
export function soleSuggestedManager(input: SuggestManagerInput): ManagerCandidate | null {
  const candidates = suggestManagers(input);
  return candidates.length === 1 ? candidates[0]! : null;
}
