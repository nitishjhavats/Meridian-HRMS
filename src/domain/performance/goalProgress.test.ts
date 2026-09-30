import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { UNIT_LABELS } from "../recognition/units";
import {
  canEditGoalDefinition,
  canRecordProgress,
  goalIsMet,
  goalPercent,
  validateProgressValue,
} from "./goalProgress";

/**
 * "Usme kitna goal ka abhi kitna hua ye update kiya ja sakta hai multiple times
 * jisse itna percent goal achieved type rahe … goal aur target edit na kar
 * sake."
 *
 * Before this, `Goal.targetValue` and `currentValue` were free text and null on
 * every goal in the production database, nothing computed a percentage, and
 * `GoalStatus.ACHIEVED` was rendered by the list and reachable from nothing.
 */

describe("goalPercent", () => {
  it("is the share of the target reached", () => {
    expect(goalPercent({ unit: "RUPEES", target: 100_000, current: 60_000 })).toBe(60);
  });

  it("shows overshooting rather than capping it", () => {
    // A target beaten by half again is 150%, and hiding that would make a
    // remarkable quarter look like an ordinary one.
    expect(goalPercent({ unit: "COUNT", target: 40, current: 60 })).toBe(150);
  });

  it("is null for a goal with no target, not zero", () => {
    // Zero reads as somebody who has done nothing, when in fact nobody ever
    // said what finished would look like. Every goal in production is this one.
    expect(goalPercent({ unit: null, target: null, current: null })).toBeNull();
  });

  it("is null for a target of zero rather than infinity", () => {
    expect(goalPercent({ unit: "COUNT", target: 0, current: 5 })).toBeNull();
  });

  it("is zero when there is a target and nothing recorded yet", () => {
    expect(goalPercent({ unit: "COUNT", target: 10, current: null })).toBe(0);
  });

  it("clamps below zero, because a bar cannot be less than empty", () => {
    expect(goalPercent({ unit: "RUPEES", target: 1000, current: -500 })).toBe(0);
  });

  it("keeps one decimal rather than pretending to more precision", () => {
    expect(goalPercent({ unit: "COUNT", target: 3, current: 1 })).toBe(33.3);
  });

  it("survives a NaN without saying 'NaN%'", () => {
    expect(goalPercent({ unit: "COUNT", target: Number.NaN, current: 5 })).toBeNull();
    expect(goalPercent({ unit: "COUNT", target: 5, current: Number.NaN })).toBe(0);
  });
});

describe("goalIsMet", () => {
  it("is met at exactly the target", () => {
    expect(goalIsMet({ unit: "COUNT", target: 10, current: 10 })).toBe(true);
  });

  it("is not met one short", () => {
    expect(goalIsMet({ unit: "COUNT", target: 10, current: 9.99 })).toBe(false);
  });

  it("is never met without a target", () => {
    expect(goalIsMet({ unit: null, target: null, current: 500 })).toBe(false);
  });
});

describe("validateProgressValue", () => {
  it("refuses what is not a number", () => {
    expect(validateProgressValue("60000").ok).toBe(false);
    expect(validateProgressValue(Number.NaN).ok).toBe(false);
    expect(validateProgressValue(null).ok).toBe(false);
  });

  it("refuses a negative", () => {
    expect(validateProgressValue(-1).ok).toBe(false);
  });

  it("rounds to two decimals rather than refusing them", () => {
    const result = validateProgressValue(1 / 3);
    expect(result.ok && result.value).toBe(0.33);
  });

  it("does not clamp a value above the target", () => {
    /**
     * Somebody typing 6000000 where they meant 60000 has made a mistake, and
     * quietly capping it at the target would hide that mistake behind a full
     * progress bar. It is accepted, shown as 10,000%, and obvious.
     */
    const result = validateProgressValue(6_000_000);
    expect(result.ok && result.value).toBe(6_000_000);
  });
});

describe("who may do what", () => {
  it("the person measured records progress and cannot edit the goal", () => {
    const them = { isOwnGoal: true, canReview: false };
    expect(canRecordProgress(them)).toBe(true);
    expect(canEditGoalDefinition(them)).toBe(false);
  });

  it("a reviewer does both", () => {
    const reviewer = { isOwnGoal: false, canReview: true };
    expect(canRecordProgress(reviewer)).toBe(true);
    expect(canEditGoalDefinition(reviewer)).toBe(true);
  });

  it("a stranger does neither", () => {
    const stranger = { isOwnGoal: false, canReview: false };
    expect(canRecordProgress(stranger)).toBe(false);
    expect(canEditGoalDefinition(stranger)).toBe(false);
  });

  it("editing your own goal still needs the review permission", () => {
    // Otherwise the target is a suggestion: the person being measured could
    // lower it the day before it was measured.
    expect(canEditGoalDefinition({ isOwnGoal: true, canReview: false })).toBe(false);
  });
});

describe("the unit vocabulary is the one Employee of the Month uses", () => {
  it("has rupees, and is not a second list", () => {
    expect(Object.keys(UNIT_LABELS)).toContain("RUPEES");
    const source = readFileSync(path.resolve("src/domain/performance/goalProgress.ts"), "utf8");
    expect(source).toMatch(/from "\.\.\/recognition\/units"/);
    // No local copy of the five keys.
    expect(source).not.toMatch(/"HOURS"\s*\|/);
  });
});

/**
 * Source guards. The whole shape of this round is features that exist and
 * cannot be reached, and goals were the worst of them: an edit path with no
 * caller, a status nothing could set, and a nav entry an employee could not see.
 */
describe("the callers", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("the service refuses a goal edit from the person being measured", () => {
    const code = strip(read("src/services/performance/index.ts"));
    expect(code).toMatch(/canEditGoalDefinition\(/);
    expect(code).toMatch(/export async function deleteGoal\(/);
    expect(code).toMatch(/export async function recordGoalProgress\(/);
  });

  it("progress writes the entry and the goal together, so they cannot disagree", () => {
    const code = strip(read("src/services/performance/index.ts"));
    const at = code.indexOf("export async function recordGoalProgress");
    const body = code.slice(at, at + 3000);
    expect(body).toMatch(/prisma\.\$transaction\(\[/);
    expect(body).toMatch(/goalProgress\.create/);
    expect(body).toMatch(/goal\.updateMany/);
  });

  it("the screen sends an id, which no client ever did", () => {
    const code = strip(read("src/app/(app)/performance/Performance.tsx"));
    expect(code).toMatch(/id: editing\.id/);
    expect(code).toMatch(/method: "DELETE"/);
    expect(code).toMatch(/progressValue/);
  });

  it("goals sit above the review cycles", () => {
    const code = read("src/app/(app)/performance/Performance.tsx");
    const ret = code.indexOf('return (\n    <div className="space-y-4">');
    const goals = code.indexOf("{goalsSection}", ret);
    const cycles = code.indexOf('title="Review cycles"', ret);
    expect(goals).toBeGreaterThan(-1);
    expect(cycles).toBeGreaterThan(-1);
    expect(goals).toBeLessThan(cycles);
  });

  it("an ordinary employee can reach the screen their goals are on", () => {
    const code = read("src/lib/navigation.ts");
    const at = code.indexOf('href: "/performance"');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 260)).toMatch(/performance\.read\.self/);
  });

  it("the assign dialog collects the target it always accepted", () => {
    const code = strip(read("src/app/(app)/performance/AssignGoal.tsx"));
    expect(code).toMatch(/targetNumber: target/);
    expect(code).toMatch(/UNIT_LABELS/);
  });
});
