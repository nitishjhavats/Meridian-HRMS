import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Whom a cycle reaches is one query.
 *
 * The screen says "opens for 12, skips 3" before the button is pressed, since
 * pressing it cannot be undone. That count lived in the page with its own
 * copy of `openCycle`'s rule -- and both matched *any* PRIMARY row, ended or
 * not, so a cycle opened after "Nobody" was chosen on the employee form still
 * handed the review to the manager they no longer had. Now `openCycle` and
 * `reviewableHeadcount` read `reviewableEmployees`, which asks for the live
 * line only. Read from the source, because a mocked client would have proved
 * the old code correct.
 */

const SERVICE = "src/services/performance/index.ts";
const PAGE = "src/app/(app)/performance/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("reviewableEmployees is the one rule", () => {
  const helper = bodyOf(SERVICE, "async function reviewableEmployees");

  it("takes active employees and the live primary line only", () => {
    expect(helper).toMatch(/where: \{ organizationId: ctx\.organizationId, active: true \}/);
    expect(helper).toMatch(
      /managers: \{ where: LIVE_PRIMARY_LINE, take: 1, select: \{ managerId: true \} \}/,
    );
    // The defect as it read: a PRIMARY row with no word about its end date.
    expect(code(SERVICE)).not.toMatch(/where: \{ type: "PRIMARY" \}/);
    expect(code(SERVICE)).not.toMatch(/some: \{ type: "PRIMARY" \}/);
  });

  it("is what openCycle assigns from", () => {
    const open = bodyOf(SERVICE, "export async function openCycle");
    expect(open).toMatch(/const \{ withManager, withoutManager \} = await reviewableEmployees\(ctx\)/);
    expect(open).not.toMatch(/prisma\.employee\.findMany/);
  });

  it("and what the headcount shown beside the button is counted from", () => {
    const count = bodyOf(SERVICE, "export async function reviewableHeadcount");
    expect(count).toMatch(/requirePermission\(ctx, "performance\.manage"\)/);
    expect(count).toMatch(/const \{ withManager, withoutManager \} = await reviewableEmployees\(ctx\)/);
    expect(count).toMatch(/total: withManager\.length \+ withoutManager\.length/);
    expect(count).toMatch(/withManager: withManager\.length/);
  });
});

describe("the page asks the service", () => {
  const page = code(PAGE);

  it("counts through reviewableHeadcount and touches no prisma of its own", () => {
    expect(page).toMatch(/canManage \? reviewableHeadcount\(ctx\) : Promise\.resolve\(undefined\)/);
    expect(page).not.toContain("@/lib/db/prisma");
    expect(page).not.toMatch(/countReviewable/);
  });

  it("offers the self-add link only where the destination would let them in", () => {
    // `/account/profile` is gated on `org.settings.write`; `employee.create`
    // alone gets the directory, where the add-employee form lives.
    expect(page).toMatch(
      /const selfAddHref = ctx\.permissions\.has\("org\.settings\.write"\)\s*\?\s*"\/account\/profile"\s*:\s*ctx\.permissions\.has\("employee\.create"\)\s*\?\s*"\/employees"\s*:\s*null/,
    );
    expect(page).toMatch(/\{selfAddHref \? \(/);
    expect(page).toMatch(/<Link href=\{selfAddHref\}/);
    expect(page).not.toMatch(/href="\/account\/profile"/);
  });
});
