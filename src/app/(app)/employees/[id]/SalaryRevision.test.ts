import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Set salary" used to spin for ever when the salary GET failed -- an expired
 * session, a dropped connection or a bad stored policy all looked the same,
 * and Save never enabled. The failure is now shown in the dialog with a retry,
 * and Save waits while it stands, because whatever breakdown is on screen is
 * not for the date that was chosen.
 */

const DIALOG = "src/app/(app)/employees/[id]/SalaryRevision.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The Save button, opening tag only. */
function saveButton(body: string): string {
  const at = body.indexOf("Save revision");
  expect(at, "no save button").toBeGreaterThan(-1);
  return body.slice(body.lastIndexOf("<Button", at), at);
}

describe("the salary dialog's load", () => {
  const body = code(DIALOG);

  it("keeps the error and clears it before asking again", () => {
    expect(body).toMatch(/const \[loadError, setLoadError\] = useState<unknown>\(null\)/);
    expect(body).toMatch(/setLoadedFor\(effectiveFrom\);\n\s*setLoadError\(null\);/);
    expect(body).toMatch(/catch \(error\) \{\n\s*setLoadError\(error\);\n\s*return;/);
  });

  it("a retry forgets which date was loaded, so the effect asks again", () => {
    expect(body).toMatch(/function retryLoad\(\) \{\n\s*setLoadError\(null\);\n\s*setLoadedFor\(null\);/);
    expect(body).toMatch(/<LoadFailed[\s\S]*?error=\{loadError\}[\s\S]*?onRetry=\{retryLoad\}/);
  });

  it("the spinner yields to the sentence", () => {
    expect(body).toMatch(/loadError === null \? \(\n\s*<LoadingState label="Loading the salary structure…" \/>/);
  });

  it("Save waits while the load has failed", () => {
    expect(saveButton(body)).toMatch(/loadError !== null \|\|/);
  });

  it("reopening the dialog starts clean", () => {
    const reset = body.slice(body.indexOf("function reset()"), body.indexOf("function start("));
    expect(reset).toMatch(/setLoadError\(null\)/);
  });
});
