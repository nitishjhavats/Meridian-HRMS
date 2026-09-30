/**
 * What an edit of an existing employee may put on the wire, and what it must
 * leave alone.
 *
 * The same dialog adds a person and edits one, and two of its fields were
 * written as if every save were a creation:
 *
 *   - `employmentState` always travelled. `updateEmployee` ignores it, but the
 *     PATCH schema only admits the states somebody can *start* in, so editing
 *     anybody who had resigned, been terminated or gone inactive -- still in
 *     the directory, still with a personal email to correct before their
 *     settlement letter -- failed validation on a field the dialog never
 *     showed;
 *   - `reportsToEmployeeId` always travelled too, and the org-chart suggestion
 *     filled it in whenever the chart was unambiguous. So fixing a typo in
 *     somebody's phone quietly ended the reporting line their manager had been
 *     chosen for and handed their leave approvals to whoever held the parent
 *     designation.
 *
 * These live here rather than in the dialog for the reason `probation.ts`
 * gives: they are decisions, not rendering, and a decision that can destroy a
 * reporting line deserves a test that fails when somebody deletes it.
 */

/**
 * The `employmentState` fragment -- **empty when editing**.
 *
 * A state change moves through `changeEmploymentState`, which records the
 * date and the reason; the edit dialog does not render the field and the
 * server would refuse a leaving state anyway. Only a new person starts
 * somewhere.
 */
export function employmentStatePatch(
  editing: boolean,
  state: string,
): { employmentState: string } | Record<string, never> {
  if (editing) return {};
  return { employmentState: state };
}

/**
 * The `reportsToEmployeeId` fragment -- **empty when editing and unchanged**.
 *
 * `updateEmployee` opens a new reporting line for any manager it is handed
 * that differs from the live one, so the only safe thing to send from an edit
 * is a choice the person at the keyboard actually made. A creation always
 * sends what it has: there is no line yet to protect.
 */
export function reportsToPatch(input: {
  editing: boolean;
  /** The live primary manager when the dialog opened; "" for nobody. */
  initial: string;
  /** What the field holds now; "" for nobody. */
  current: string;
}): { reportsToEmployeeId: string | null } | Record<string, never> {
  if (input.editing && input.current === input.initial) return {};
  return { reportsToEmployeeId: input.current || null };
}

/**
 * The manager the org chart may fill in on its own, or null.
 *
 * Only ever into an empty field, only when exactly one person holds the
 * parent designation, and -- the part that was missing -- only while the
 * designation is something the user is choosing: on a new person, or on an
 * existing one after the designation was changed. Opening an edit dialog is
 * not choosing a designation, and a suggestion applied then is a reassignment
 * nobody asked for.
 */
export function autoSuggestedManager(input: {
  editing: boolean;
  designationChanged: boolean;
  /** What the field holds now; "" for nobody. */
  chosen: string;
  candidates: { id: string }[];
}): string | null {
  if (input.editing && !input.designationChanged) return null;
  if (input.chosen) return null;
  if (input.candidates.length !== 1) return null;
  return input.candidates[0]!.id;
}
