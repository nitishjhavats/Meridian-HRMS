import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Who "Start an exit" offers, and what it says when it can offer nobody.
 *
 * The picker filtered on "has no exit record". An exit that was cancelled --
 * somebody withdrew a resignation -- is still a record, so after the first
 * withdrawal that person could never be exited from the app again, even
 * though the service reopens a cancelled row on purpose. And with nobody to
 * offer, the form opened anyway: an empty dropdown and a greyed-out Start.
 */

const PAGE = "src/app/(app)/exit/page.tsx";
const LIST = "src/app/(app)/exit/ExitList.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the employee picker", () => {
  const page = code(PAGE);

  it("offers active people with no exit or a cancelled one", () => {
    const query = page.slice(page.indexOf("prisma.employee.findMany("), page.indexOf("orderBy:"));
    expect(query).toMatch(/active: true/);
    expect(query).toMatch(/OR: \[\{ exitRecord: null \}, \{ exitRecord: \{ status: "CANCELLED" \} \}\]/);
    // The old filter, which hid a withdrawn resignation's owner for good.
    expect(query).not.toMatch(/active: true, exitRecord: null/);
  });

  it("counts everyone active as well, so an empty picker can say which reason applies", () => {
    expect(page).toMatch(/prisma\.employee\.count\(\{ where: \{ organizationId: ctx\.organizationId!, active: true \} \}\)/);
    expect(page).toMatch(/<StartExit[\s\S]*?activeCount=\{activeCount\}/);
  });
});

describe("Start an exit with nobody to offer", () => {
  const list = code(LIST);
  const start = list.slice(list.indexOf("export function StartExit("));

  it("explains instead of opening the form", () => {
    const branch = start.slice(start.indexOf("if (employees.length === 0)"), start.indexOf("return (\n    <form"));
    expect(branch).toMatch(/const nobodyYet = activeCount === 0/);
    expect(branch).toMatch(/Nobody can be started right now/);
    expect(branch).toMatch(/There are no active employees yet/);
    expect(branch).toMatch(/Everybody active already has an exit in progress/);
    expect(branch).toMatch(/href="\/employees"/);
  });

  it("before the form, so the form never renders with an empty dropdown", () => {
    expect(start.indexOf("if (employees.length === 0)")).toBeLessThan(start.indexOf("<form"));
  });
});

describe("a cancelled row", () => {
  it("says it was withdrawn and can be started again, in the table and on the card", () => {
    const list = code(LIST);
    expect(list).toMatch(/const WITHDRAWN = "withdrawn · can be started again"/);
    expect(list.match(/e\.status === "CANCELLED" \? \(\s*<(span|p)[^>]*>\{WITHDRAWN\}/g)).toHaveLength(2);
  });
});
