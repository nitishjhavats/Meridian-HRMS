/**
 * Assigning one goal to several people at once.
 *
 * The decision worth writing down is what happens to an id the caller sent that
 * does not resolve to somebody they may set a goal for — a stale browser tab, a
 * hand-written request, or an employee id belonging to another organisation.
 *
 * Dropping those quietly is the dangerous answer: the screen would report "goal
 * set for 5 people" whether five, four or one row was written, and nobody would
 * ever find out which. So the unresolved ids come back named and the caller
 * refuses the whole assignment rather than writing part of it.
 */

export interface GoalAssignmentPlan {
  /** Who to write a goal for: deduplicated, in the order they were sent. */
  employeeIds: string[];
  /** Ids that matched nobody the caller may set a goal for. */
  unresolved: string[];
}

/**
 * @param requested  the ids the caller asked for, in their order, possibly with
 *                   repeats.
 * @param assignable the ids that resolved to an employee in the caller's own
 *                   organisation and within their visible scope.
 */
export function planGoalAssignment(
  requested: readonly string[],
  assignable: Iterable<string>,
): GoalAssignmentPlan {
  const allowed = new Set(assignable);
  const seen = new Set<string>();
  const employeeIds: string[] = [];
  const unresolved: string[] = [];

  for (const id of requested) {
    // The same person ticked twice is one goal, not two. A repeat is a client
    // artefact rather than an instruction.
    if (seen.has(id)) continue;
    seen.add(id);
    if (allowed.has(id)) employeeIds.push(id);
    else unresolved.push(id);
  }

  return { employeeIds, unresolved };
}
