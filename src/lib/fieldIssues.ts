import type { ZodIssue } from "zod";

/**
 * What a form got wrong, field by field.
 *
 * The route handler has always put every zod issue into the error envelope as
 * `details.issues`, and the message beside them said "Please check the
 * highlighted fields." Nothing outside the payroll rule editor ever read the
 * issues, so on every other form the toast promised a highlight that was not
 * there and the person retried blind -- `/signup` with `a@b`, a phone one
 * character too long, a one-letter device label.
 *
 * Two things fix that. The message now names the first field itself, so a form
 * that reads nothing but the message still says which box. And a form that
 * wants the error under the box has `issueFor`, which the client hook in
 * `lib/client/fieldIssues` wraps.
 *
 * Pure and dependency-free on purpose: the server builds these and a client
 * component reads them back, and neither side should pull the other's imports
 * in. `ZodIssue` is a type import only.
 */

export interface FieldIssue {
  /** Dotted path into the body -- `name`, `devices.0.label`. Empty at the root. */
  path: string;
  message: string;
}

export function fieldIssuesFrom(issues: readonly ZodIssue[]): FieldIssue[] {
  return issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/**
 * The first issue reported against a field, for a `Field`'s `error`.
 *
 * A form binds a box to `name`; the schema may have refused `name` itself or
 * something inside it (`address.line1` under a box called `address`). Both
 * belong under that box, and the exact match wins when there is one.
 */
export function issueFor(issues: readonly FieldIssue[], name: string): string | undefined {
  const exact = issues.find((i) => i.path === name);
  if (exact) return exact.message;
  return issues.find((i) => i.path.startsWith(`${name}.`))?.message;
}

/** The generic line, kept for a form that has nothing better to say. */
export const CHECK_FIELDS = "Please check the highlighted fields.";

/**
 * One sentence for the envelope's `message`, naming the first field.
 *
 * `Please check name: String must contain at least 2 character(s).` is not
 * pretty, but it is the difference between a person fixing the box and a
 * person giving up. The count of the rest is there so "fixed that, still
 * refused" is not a surprise.
 */
export function describeIssues(issues: readonly FieldIssue[]): string {
  const first = issues[0];
  if (!first) return CHECK_FIELDS;

  const message = /[.!?]$/.test(first.message) ? first.message : `${first.message}.`;
  // A root issue names no box -- a union that matched nothing, usually -- so
  // the sentence says what was said rather than pointing at a field.
  const lead = first.path
    ? `Please check ${first.path}: ${message}`
    : `Please check what you entered: ${message}`;
  const rest = issues.length - 1;
  return rest > 0 ? `${lead} And ${rest} other field${rest === 1 ? "" : "s"}.` : lead;
}
