import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Add a line" used to open two pickers with nobody in them when the options
 * fetch was refused, and a button that could never enable -- no hint whether
 * the list had been refused or the directory was empty. The form now tells
 * the three apart: still loading, refused (with the reason and a retry when
 * one could help), and genuinely nobody.
 */

const SCREEN = "src/app/(app)/settings/organisation/ReportingLines.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The add-a-line form, from its dashed border to its submit button. */
function addForm(body: string): string {
  const start = body.indexOf("{adding && canWrite ? (");
  expect(start, "no add form").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("Add the line", start));
}

describe("the people pickers", () => {
  const body = code(SCREEN);

  it("know the difference between not loaded and nobody", () => {
    expect(body).toMatch(/useState<Person\[\] \| null>\(null\)/);
  });

  it("keep the options failure instead of dropping it", () => {
    expect(body).toMatch(/const \[peopleError, setPeopleError\] = useState<unknown>\(null\)/);
    expect(body).toMatch(/catch \(error\) \{\n\s*setPeopleError\(error\);/);
  });

  it("say which of the three it is, above the pickers", () => {
    const form = addForm(body);
    expect(form).toMatch(/peopleError !== null \? \(\n\s*<LoadFailed[\s\S]*?onRetry=\{\(\) => void loadPeople\(\)\}/);
    expect(form).toMatch(/people === null \? \(/);
    expect(form).toMatch(/Loading the people to choose from/);
    expect(form).toMatch(/people\.length === 0 \? \(/);
    expect(form).toMatch(/Nobody to choose from yet/);
  });

  it("are off until there is somebody to pick", () => {
    const form = addForm(body);
    const pickers = form.match(/disabled=\{people === null \|\| people\.length === 0\}/g) ?? [];
    expect(pickers).toHaveLength(2);
  });
});

describe("the lines list", () => {
  it("shows its own failure with a retry", () => {
    const body = code(SCREEN);
    expect(body).toMatch(/const \[linesError, setLinesError\] = useState<unknown>\(null\)/);
    expect(body).toMatch(/linesError !== null \? \(\n\s*<LoadFailed[\s\S]*?onRetry=\{\(\) => void load\(\)\}/);
  });
});
