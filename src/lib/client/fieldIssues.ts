"use client";

import { useCallback, useState } from "react";
import { type FieldIssue, issueFor } from "../fieldIssues";
import { RequestFailed } from "./api";

/**
 * The server's field-by-field refusals, ready for a `Field`'s `error`.
 *
 * `mutate` toasts a refusal and hands back `null`, which is right for "That
 * was not saved" and useless for "which box". The envelope has carried
 * `details.issues` all along; this is the small piece that gets them from the
 * failed request to the field, without every form re-implementing the catch.
 *
 * Use it around the request, inside `mutate` so the toast still happens:
 *
 *     const fieldIssues = useFieldIssues();
 *     await mutate(() => fieldIssues.watch(api(...)), { ... });
 *     <Field error={fieldIssues.messageFor("name")} ...>
 *
 * A refusal that names no field leaves nothing here; the toast has said what it
 * can. Success clears whatever was showing.
 */

function isFieldIssue(value: unknown): value is FieldIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FieldIssue).path === "string" &&
    typeof (value as FieldIssue).message === "string"
  );
}

/** The issues a failed request carried, or none. */
export function issuesOf(error: unknown): FieldIssue[] {
  if (!(error instanceof RequestFailed) || error.error.code !== "VALIDATION") return [];
  const details = error.error.details as { issues?: unknown } | undefined;
  return Array.isArray(details?.issues) ? details.issues.filter(isFieldIssue) : [];
}

export function useFieldIssues() {
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  // Records and rethrows, so the caller's `mutate` still toasts and still
  // returns null. Swallowing here would make a refused save look like one that
  // went through.
  const watch = useCallback(<T>(request: Promise<T>): Promise<T> => {
    return request.then(
      (value) => {
        setIssues([]);
        return value;
      },
      (error: unknown) => {
        setIssues(issuesOf(error));
        throw error;
      },
    );
  }, []);

  const clear = useCallback(() => setIssues([]), []);

  return {
    issues,
    /** The first issue against this field, or nothing. */
    messageFor: (name: string) => issueFor(issues, name),
    watch,
    clear,
  };
}
