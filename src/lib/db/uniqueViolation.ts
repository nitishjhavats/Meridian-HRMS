/**
 * Prisma's "that unique value is taken", recognised without importing Prisma.
 *
 * A `P2002` is not an `AppError`, so a write that trips a unique index falls
 * through the route handler as a 500 -- "something went wrong on our side",
 * a correlation id, a stack in the log -- for what is a plain "that name is
 * already used". Every service that writes a row somebody can name should
 * catch this and say so. Checked by code rather than `instanceof`, the way
 * `billing/orders.ts` does, so a test can throw a bare `{ code: "P2002" }`.
 *
 * `column` narrows it to one index when a table has several: a letter
 * template is unique per category *and* per title, and only one of those is
 * the person's mistake.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  if (!column) return true;

  // Postgres reports the index's columns as an array; other connectors have
  // sent a string. One that names nothing is taken as the column asked about:
  // a wrong "already exists" is a better answer than the 500 it replaces.
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.includes(column);
  if (typeof target === "string") return target.includes(column);
  return true;
}
