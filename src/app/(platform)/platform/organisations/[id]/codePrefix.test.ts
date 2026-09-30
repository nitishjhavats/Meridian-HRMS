import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The employee-code prefix box on the platform console.
 *
 * Backspacing it to nothing, or to two letters, and saving was a 500: the
 * domain refuses with a plain Error and the route reported that as a crash.
 * The box also took three letters while the column, the domain and two live
 * organisations (JVNK, KMWL) have four. The handler now answers the domain's
 * refusal as a validation error -- see `lib/http/handler.test.ts` -- and this
 * form does not send one in the first place.
 */

const FORM = "src/app/(platform)/platform/organisations/[id]/OrganizationProfile.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the employee code prefix box", () => {
  const form = code(FORM);

  it("takes the four letters the domain does", () => {
    const box = form.slice(form.indexOf('id="org-prefix"'));
    expect(box.slice(0, box.indexOf("/>"))).toMatch(/maxLength=\{4\}/);
    expect(form).not.toMatch(/Exactly three letters/);
  });

  it("holds Save while the prefix would be refused", () => {
    expect(form).toMatch(/const prefixOk = isValidCodePrefix\(form\.employeeCodePrefix\);/);
    expect(form).toMatch(/disabled=\{busy \|\| !dirty \|\| !prefixOk\}/);
    expect(form).toMatch(/error=\{prefixOk \? undefined : "Three or four letters, A to Z\."\}/);
  });
});
