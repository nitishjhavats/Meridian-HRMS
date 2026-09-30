import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_WEEKLY_OFF } from "@/domain/calendar/weeklyOff";
import { resolveWeeklyOff } from "./weeklyOff";

/**
 * The order the resolver consults, pinned.
 *
 * Four layers, and each exists for a reason somebody once lost a day's pay
 * over: the person's own days, then their named pattern, then the
 * organisation's default row, then the shipped Sunday. The database is a stub
 * that answers the one query the resolver may make, so a test that reaches it
 * when it should not is a test that fails.
 */

const ORG_DEFAULT = { type: "MULTIPLE", days: [0, 6] };
const NAMED = { type: "ROTATIONAL", days: [0], rotating: [{ day: 6, weeks: [2, 4] }] };

function db(defaultRow: unknown | null = ORG_DEFAULT) {
  const calls: unknown[] = [];
  return {
    calls,
    weeklyOffPattern: {
      findFirst: async (args: unknown) => {
        calls.push(args);
        return defaultRow ? { config: defaultRow } : null;
      },
    },
  } as unknown as Parameters<typeof resolveWeeklyOff>[0] & { calls: unknown[] };
}

describe("resolveWeeklyOff", () => {
  it("the person's own days beat their named pattern", async () => {
    const stub = db();
    const result = await resolveWeeklyOff(stub, "org_1", {
      weeklyOffConfig: { type: "FIXED", days: [2] },
      weeklyOffPattern: { config: NAMED },
    });
    expect(result).toEqual({ type: "FIXED", days: [2] });
    expect(stub.calls).toHaveLength(0);
  });

  it("the named pattern beats the organisation default", async () => {
    const stub = db();
    const result = await resolveWeeklyOff(stub, "org_1", {
      weeklyOffConfig: null,
      weeklyOffPattern: { config: NAMED },
    });
    expect(result).toEqual(NAMED);
    expect(stub.calls).toHaveLength(0);
  });

  it("the organisation default beats the shipped Sunday", async () => {
    const stub = db();
    const result = await resolveWeeklyOff(stub, "org_1", {
      weeklyOffConfig: null,
      weeklyOffPattern: null,
    });
    expect(result).toEqual(ORG_DEFAULT);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ where: { organizationId: "org_1", isDefault: true, active: true } });
  });

  it("Sunday only when the organisation has no default row at all", async () => {
    const result = await resolveWeeklyOff(db(null), "org_1", {
      weeklyOffConfig: null,
      weeklyOffPattern: null,
    });
    expect(result).toEqual(DEFAULT_WEEKLY_OFF);
  });

  it("a missing employee resolves like one on the organisation default", async () => {
    expect(await resolveWeeklyOff(db(), "org_1", null)).toEqual(ORG_DEFAULT);
    expect(await resolveWeeklyOff(db(), "org_1", undefined)).toEqual(ORG_DEFAULT);
  });

  it("a personal config it cannot read falls through rather than being trusted", async () => {
    // A column written by something other than the card. Every one of these
    // would otherwise resolve to "no rest days" for that person.
    for (const bad of [
      { type: "FIXED", days: [] },
      { type: "FIXED", days: [0, 1, 2, 3, 4, 5, 6] },
      { type: "FIXED", days: [7] },
      { type: "ROTATIONAL", days: [0] },
      { type: "FIXED" },
      "Sunday",
      42,
    ]) {
      const result = await resolveWeeklyOff(db(), "org_1", {
        weeklyOffConfig: bad,
        weeklyOffPattern: { config: NAMED },
      });
      expect(result, JSON.stringify(bad)).toEqual(NAMED);
    }
  });

  it("normalises the personal days it does accept", async () => {
    const result = await resolveWeeklyOff(db(), "org_1", {
      weeklyOffConfig: { type: "FIXED", days: [5, 2, 5] },
      weeklyOffPattern: null,
    });
    expect(result).toEqual({ type: "MULTIPLE", days: [2, 5] });
  });
});

/**
 * Every caller hands the resolver the row's two columns, not just the pattern.
 *
 * The parameter type makes `weeklyOffConfig` required, so a caller that selects
 * only the pattern fails to compile — but a caller that selects neither and
 * passes `null` compiles fine and quietly puts everybody on the organisation
 * default. This checks that the four services select the column.
 */
describe("every caller selects the personal column", () => {
  const strip = (file: string) =>
    readFileSync(path.resolve(file), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it.each([
    "src/services/leave/index.ts",
    "src/services/payroll/inputBuilder.ts",
    "src/services/payroll/samplePayslip.ts",
  ])("%s", (file) => {
    const source = strip(file);
    expect(source).toMatch(/resolveWeeklyOff\(/);
    expect(source).toMatch(/weeklyOffConfig: true/);
    expect(source).toMatch(/weeklyOffPattern: \{ select: \{ config: true \} \}/);
  });

  it("attendance reads the column itself when its caller left it out", () => {
    const source = strip("src/services/attendance/record.ts");
    expect(source).toMatch(/weeklyOffConfig\?: unknown/);
    expect(source).toMatch(/select: \{ weeklyOffConfig: true \}/);
  });
});
