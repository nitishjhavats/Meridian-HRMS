import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every report downloads as a file the operating system can open.
 *
 * `salary-breakdown` named its file `salary-breakdown-2026-08` — no extension —
 * so the browser wrote exactly that to disk and Windows offered no application
 * for it. Nothing failed, no error was logged, and the person who asked for the
 * report simply could not read it.
 *
 * There is no decision here to extract into `src/domain/`: the filenames are
 * string literals, and the only thing worth pinning is that none of them
 * forgets the suffix again. So this reads the service's own source. If a report
 * that is genuinely not a CSV is ever added, this test is the place that has to
 * be told about it — deliberately, rather than by a file nobody can open.
 */

const SOURCE = readFileSync(path.resolve("src/services/reports/index.ts"), "utf8");

/** Comments stripped, so a filename mentioned in prose is not read as code. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("report filenames", () => {
  const declarations = [...CODE.matchAll(/filename: `([^`]+)`/g)].map((m) => m[1]!);

  it("finds one filename for every report the catalogue declares", () => {
    // A guard that matches nothing passes for the wrong reason, and a report
    // added without a filename is the other half of the same mistake.
    const kinds = [...CODE.matchAll(/kind: "([a-z-]+)",/g)].length;
    expect(kinds).toBeGreaterThan(0);
    expect(declarations.length).toBe(kinds);
  });

  it("gives every one an extension a spreadsheet will open", () => {
    for (const name of declarations) {
      expect(name.endsWith(".csv"), `${name} has no .csv extension`).toBe(true);
    }
  });

  it("names the salary breakdown, which was the one that did not", () => {
    expect(CODE).toContain('filename: `salary-breakdown-${year}-${String(month).padStart(2, "0")}.csv`');
  });
});

describe("the response that carries them", () => {
  const HANDLER = readFileSync(path.resolve("src/lib/http/handler.ts"), "utf8");

  it("still sends the type and the name together", () => {
    // The extension is only half of it: a browser saving the file consults the
    // header as well as the name, and both come from `csvResponse`.
    expect(HANDLER).toContain('"Content-Type": "text/csv; charset=utf-8"');
    expect(HANDLER).toMatch(/"Content-Disposition": `attachment; filename="\$\{filename\}"`/);
  });

  it("is what the report route hands the filename to", () => {
    const ROUTE = readFileSync(path.resolve("src/app/api/reports/[kind]/route.ts"), "utf8");
    expect(ROUTE).toMatch(/csvResponse\(result\.filename, result\.rows\)/);
  });
});
