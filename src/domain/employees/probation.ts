/**
 * When training or probation ends, and when that date may be written.
 *
 * Both answers were inline in the employee dialog, and both were wrong in a way
 * that only showed up in use:
 *
 *   - the suggestion hung off the *state* dropdown's change handler, so the
 *     ordinary path -- type a joining date, leave "On probation" selected --
 *     produced no date at all, because nobody had touched the dropdown;
 *   - the payload always carried `confirmationDate`, including from an edit
 *     dialog that never rendered the input. `updateEmployee` applies whatever
 *     it is handed, so renaming a permanent employee sent `null` and erased the
 *     date they were confirmed on.
 *
 * They live here because they are decisions, not rendering, and because a rule
 * that destroys data deserves a test that fails when somebody deletes it.
 */

/** States that are on the way to permanent, and so have an end date. */
const PROVISIONAL = new Set(["TRAINING", "PROBATION"]);

export function isProvisional(state: string): boolean {
  return PROVISIONAL.has(state);
}

/**
 * The joining date plus whichever default applies.
 *
 * A suggestion, never a rule -- the field stays editable, because plenty of
 * people are hired on terms that differ from the default, and a date somebody
 * cannot change is a date they work around.
 *
 * Returns `""` for a state that has no end date, and for a joining date that is
 * missing or unparseable: a blank field is honest, an invented date is not.
 */
export function suggestedConfirmationDate(input: {
  joiningDate: string;
  state: string;
  trainingDays: number;
  probationDays: number;
}): string {
  if (!isProvisional(input.state)) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.joiningDate)) return "";

  const start = new Date(`${input.joiningDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return "";

  const days = input.state === "TRAINING" ? input.trainingDays : input.probationDays;
  if (!Number.isFinite(days)) return "";

  start.setUTCDate(start.getUTCDate() + Math.round(days));
  return start.toISOString().slice(0, 10);
}

/**
 * The `confirmationDate` fragment of an employee payload -- **an empty object
 * when the field was not on screen**.
 *
 * `updateEmployee` distinguishes an absent key from a null one, which is what
 * makes this safe: omitting it leaves the stored date alone, while a rendered
 * field that was cleared still sends `null` and clears it.
 */
export function confirmationDatePatch(
  state: string,
  value: string,
): { confirmationDate: string | null } | Record<string, never> {
  if (!isProvisional(state)) return {};
  return { confirmationDate: value || null };
}
