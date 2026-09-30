import { describe, expect, it } from "vitest";

import { isUniqueViolation } from "./uniqueViolation";

/**
 * A `P2002` is Prisma's "that unique value is taken". It is not an `AppError`,
 * so anywhere it is not caught it reaches the person as a 500 with a reference
 * to quote -- which is what adding "Manager" twice as a designation did.
 */
describe("isUniqueViolation", () => {
  it("recognises Prisma's code without needing Prisma's class", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("P2002"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
  });

  it("can be asked about one index when a table has several", () => {
    const onTitle = { code: "P2002", meta: { target: ["organizationId", "title"] } };
    const onCategory = { code: "P2002", meta: { target: ["organizationId", "category"] } };
    expect(isUniqueViolation(onTitle, "title")).toBe(true);
    expect(isUniqueViolation(onCategory, "title")).toBe(false);
    // Some connectors report the index as one string.
    expect(isUniqueViolation({ code: "P2002", meta: { target: "LetterTemplate_organizationId_title_key" } }, "title")).toBe(true);
  });

  it("takes an unnamed index as the one asked about", () => {
    // A wrong "already exists" beats the 500 it replaces.
    expect(isUniqueViolation({ code: "P2002" }, "title")).toBe(true);
  });
});
