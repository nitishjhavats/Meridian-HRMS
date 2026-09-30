import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultFramework } from "./defaults";
import { LETTER_CATEGORY_ORDER } from "./defaults";
import { isShippedBody, shippedBodies } from "./shipped";

const OLD_SIGN_OFF = [
  "Yours sincerely,",
  "",
  "{{signatory.name}}",
  "{{signatory.title}}",
  "{{organization.name}}",
].join("\n");

describe("isShippedBody", () => {
  it("recognises today's default for every category", () => {
    for (const category of LETTER_CATEGORY_ORDER) {
      expect(isShippedBody(category, defaultFramework(category).body), category).toBe(true);
    }
  });

  it("recognises the pre-round-3 body, which is what the frozen rows hold", () => {
    // The exact shape `setFrameworkSignature` copied in before the sign-off was
    // trimmed. These rows are the whole reason this module exists.
    for (const category of LETTER_CATEGORY_ORDER) {
      const current = defaultFramework(category).body;
      const previous = current.replace(/Yours sincerely,$/, OLD_SIGN_OFF);
      expect(previous, category).not.toBe(current);
      expect(isShippedBody(category, previous), category).toBe(true);
    }
  });

  it("does not claim a body somebody wrote", () => {
    const mine = `${defaultFramework("OFFER").body}\n\nWe also offer a cycle-to-work scheme.`;
    expect(isShippedBody("OFFER", mine)).toBe(false);
  });

  it("does not match one category against another", () => {
    // A cross-category match would let the script free wording an organisation
    // had deliberately moved from one letter to another.
    expect(isShippedBody("OFFER", defaultFramework("TERMINATION").body)).toBe(false);
    expect(isShippedBody("WARNING", defaultFramework("EXPERIENCE").body)).toBe(false);
  });

  it("is false for a row that never overrode the wording", () => {
    // Null is "no override", not "shipped text". Conflating them would have the
    // editor announce a restore for a template that is already following the
    // built-in.
    expect(isShippedBody("OFFER", null)).toBe(false);
  });

  it("is exact, not fuzzy", () => {
    const body = defaultFramework("RELIEVING").body;
    expect(isShippedBody("RELIEVING", body + " ")).toBe(false);
    expect(isShippedBody("RELIEVING", " " + body)).toBe(false);
    expect(isShippedBody("RELIEVING", body.replace("relieved", "released"))).toBe(false);
    // One placeholder swapped for another is the smallest real edit somebody
    // makes, and it must not be mistaken for the shipped text.
    expect(
      isShippedBody("RELIEVING", body.replace("{{employee.name}}", "{{employee.code}}")),
    ).toBe(false);
  });

  it("offers both shapes and nothing else", () => {
    for (const category of LETTER_CATEGORY_ORDER) {
      expect(shippedBodies(category), category).toHaveLength(2);
    }
  });
});

/** Pinning a pure function does not pin its caller. */
describe("both callers use it", () => {
  it("the bulk script does", () => {
    const source = readFileSync("scripts/unfreeze-letters.mts", "utf8");
    expect(source).toContain("isShippedBody");
    expect(source).toContain("domain/letters/shipped");
  });

  it("the template service does", () => {
    const source = readFileSync("src/services/letters/templates.ts", "utf8");
    expect(source).toContain("isShippedBody");
  });
});
