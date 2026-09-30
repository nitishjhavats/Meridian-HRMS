import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Nothing is issued to nobody.
 *
 * A brand-new organisation has assets before it has people. Issue opened a
 * panel with an empty select, Confirm posted `employeeId: ""`, and the toast
 * said the employee could not be found -- which was true, and no help.
 */

const SCREEN = "src/app/(app)/assets/AssetRegister.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("issuing an asset", () => {
  const body = code(SCREEN);
  const available = body.slice(
    body.indexOf('if (a.status === "AVAILABLE")'),
    body.indexOf("return null;", body.indexOf('if (a.status === "AVAILABLE")')),
  );

  it("is held, with a way forward, while the organisation has nobody to issue to", () => {
    expect(available).toMatch(/if \(employees\.length === 0\)/);
    expect(available).toMatch(/<Button size="sm" disabled>/);
    expect(available).toMatch(/<Link href="\/employees"[^>]*>\s*Add an employee\s*<\/Link>/);
  });

  it("settles on a real person when the panel opens, even if the roster changed underneath", () => {
    expect(available).toMatch(/employees\.some\(\(e\) => e\.id === issue\.employeeId\)/);
    expect(available).toMatch(/employeeId: employees\[0\]!\.id/);
  });

  it("and Confirm never posts an empty employee id", () => {
    const confirm = body.slice(body.indexOf('action: "issue"') - 400, body.indexOf('action: "issue"'));
    expect(confirm).toMatch(/disabled=\{!issue\.employeeId\}/);
  });
});
