import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Two facts about policy versions that are only right together.
 *
 * `savePolicyVersion` retires every earlier version when it publishes, so
 * `active` marks the current head and nothing else. `loadPolicy` answers "the
 * rules in force on a date", and a retired version *was* in force on the
 * dates it covered -- so it must not filter on `active`, or any date before
 * the head's `effectiveFrom` matches no row and falls through to the shipped
 * defaults. That is what happened: after one settings save on the live
 * instance, payroll for the previous month ran on the default shift and the
 * default missing-checkout rule, and the nightly close judged older dates by
 * rules that were never in force on them.
 *
 * Either fact on its own is defensible; each is what makes the other safe.
 * Filter on `active` and history is gone. Stop retiring and `active` means
 * nothing again (production once carried two active ATTENDANCE policies for
 * one organisation). So they are pinned in one file.
 *
 * Source assertions, because both are the shape of a Prisma query and this
 * repository does not mock Prisma.
 */

const POLICY = "src/services/policy.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function block(body: string, from: string): string {
  const start = body.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("the rules in force on a date come from history, not from the head", () => {
  it("loadPolicy does not filter on active", () => {
    const load = block(code(POLICY), "async function loadPolicy");
    const where = load.slice(load.indexOf("where: {"), load.indexOf("orderBy:"));
    expect(where).not.toMatch(/active/);
  });

  it("and picks the latest effectiveFrom at or before the date, highest version first", () => {
    const load = block(code(POLICY), "async function loadPolicy");
    expect(load).toMatch(/effectiveFrom: \{ lte: new Date\(`\$\{on\}T00:00:00\.000Z`\) \}/);
    expect(load).toMatch(/orderBy: \[\{ effectiveFrom: "desc" \}, \{ version: "desc" \}\]/);
  });
});

describe("and publishing still retires what it replaces", () => {
  it("savePolicyVersion clears active on every earlier version of the kind", () => {
    // Without this `active` means nothing and the ordering above is the only
    // thing picking the right row; with it, the flag is a trustworthy "current
    // head" for anything that needs one without a date.
    const save = block(code(POLICY), "export async function savePolicyVersion");
    expect(save).toMatch(
      /updateMany\(\{\s*where: \{ organizationId: ctx\.organizationId, kind, active: true \},\s*data: \{ active: false \},/,
    );
    expect(save).toMatch(/active: true,/);
  });
});
