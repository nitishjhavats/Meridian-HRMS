import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A one-letter name on /account/profile went to the server, failed zod's
 * `min(2)`, and came back as "Please check the highlighted fields" with
 * nothing highlighted -- the person had cleared the box, typed a letter, and
 * the only thing that lit up was Save. The box now says why before Save is
 * live, and whatever the server refuses field by field lands under the field
 * through `useFieldIssues`, of which this form is the first consumer.
 */

const FORM = "src/app/(app)/account/profile/ProfileForm.tsx";
const ROUTE = "src/app/api/account/profile/route.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the profile form and a name the route would refuse", () => {
  const form = code(FORM);

  it("applies the route's own limits", () => {
    const route = code(ROUTE);
    const [, min, max] = /name: z\.string\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(route) ?? [];
    expect(form).toMatch(new RegExp(`const NAME_MIN = ${min};`));
    expect(form).toMatch(new RegExp(`const NAME_MAX = ${max};`));
  });

  it("holds Save and says why under the box", () => {
    expect(form).toMatch(/disabled=\{busy \|\| !dirty \|\| Boolean\(nameError\)\}/);
    expect(form).toMatch(/error=\{nameError \?\? fieldIssues\.messageFor\("name"\)\}/);
  });

  it("puts the server's field issues under the fields", () => {
    expect(form).toMatch(/const fieldIssues = useFieldIssues\(\);/);
    expect(form).toMatch(/fieldIssues\.watch\(\s*api\("\/api\/account\/profile"/);
    expect(form).toMatch(/error=\{fieldIssues\.messageFor\("designationId"\)\}/);
  });
});
