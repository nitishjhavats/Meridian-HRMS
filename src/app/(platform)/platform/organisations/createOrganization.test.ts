import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { suggestCodePrefix } from "@/domain/employees/code";

/**
 * The New organisation dialog fills the code prefix in from the name.
 *
 * It was meant to since the suggestion existed, and never did: the box starts
 * blank, `suggestCodePrefix("")` is `EMP`, and the "still showing the
 * suggestion?" comparison was false before the first keystroke. The required
 * field stayed empty and the Create button stayed disabled with nothing beside
 * it saying why -- the blank was three fields up.
 */

const FORM = "src/app/(platform)/platform/organisations/CreateOrganization.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the employee code prefix suggestion", () => {
  const form = code(FORM);

  it("is the reason the old comparison could never be true", () => {
    // The premise of the fix, pinned: a blank name suggests the default, not
    // a blank, so a blank box never equalled the suggestion for a blank name.
    expect(suggestCodePrefix("")).toBe("EMP");
    expect(suggestCodePrefix("")).not.toBe("");
  });

  it("compares against a blank suggestion for a blank name", () => {
    expect(form).toMatch(/function suggestedPrefixFor\(name: string\): string \{\s*return name\.trim\(\) === "" \? "" : suggestCodePrefix\(name\);/);
    expect(form).toMatch(/f\.employeeCodePrefix === suggestedPrefixFor\(f\.name\)\s*\?\s*suggestedPrefixFor\(value\)/);
    expect(form).not.toMatch(/f\.employeeCodePrefix === suggestCodePrefix\(f\.name\)/);
  });

  it("takes the four letters the suggestion and the domain give", () => {
    const box = form.slice(form.indexOf('id="employeeCodePrefix"'));
    expect(box.slice(0, box.indexOf("/>"))).toMatch(/maxLength=\{4\}/);
    // The proof that three was too few: real names squeeze to four.
    expect(suggestCodePrefix("Jivonik Ayurveda")).toHaveLength(4);
  });
});

describe("the disabled Create button", () => {
  const form = code(FORM);

  it("says what is still needed", () => {
    expect(form).toMatch(/const valid = missing\.length === 0;/);
    expect(form).toMatch(/Still needed: \{missing\.join\(", "\)\}\./);
  });
});
