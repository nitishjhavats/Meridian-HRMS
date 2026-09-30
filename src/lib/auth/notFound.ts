import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";

/**
 * Turns a service's `NotFoundError` into the framework's 404.
 *
 * `pageGuard` handles the refusals that can be decided *before* a fetch — no
 * permission, module off, no employee record. This handles the one that can
 * only be decided *during* it: the record is outside what this person may see.
 *
 * That case is a 404 and not a 403 on purpose, and the rule is enforced in the
 * services (`visibleEmployeeIds` returning a list the id is not in). Telling a
 * team lead "you may not view employee X" confirms that employee X exists,
 * which is the thing the scope was hiding.
 *
 * Without this the error reached `(app)/error.tsx`, whose own header promises
 * that "expected refusals ... are handled where they happen" and that anything
 * arriving there "is a genuine fault". A manager opening a colleague outside
 * their team got "Something went wrong. The problem has been logged." — a
 * crash screen and a logged fault, for the guard working exactly as designed.
 *
 * Use it as `.catch(asNotFound)` on the loading call. Anything that is not a
 * `NotFoundError` is rethrown untouched, so real faults still reach the
 * boundary.
 */
export function asNotFound(error: unknown): never {
  if (error instanceof NotFoundError) notFound();
  throw error;
}
