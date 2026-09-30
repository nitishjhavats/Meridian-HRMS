import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { planGoalAssignment } from "@/domain/performance/goalAssignment";

/**
 * Who may write a goal, and whose.
 *
 * `upsertGoal` took an optional `id` and, when it was given, ran
 * `prisma.goal.update({ where: { id: input.id } })`. There was no organisation
 * in that `where` and no check on whose goal the row was: the only ownership
 * test in the function compared `input.employeeId` — a value the caller sends —
 * against the session. So any signed-in user could pass their own employee id
 * with somebody else's goal id and rewrite that goal's title, status and due
 * date. Across tenants, because nothing narrowed the row to this organisation.
 *
 * The fix is structural rather than a new condition, which is why these tests
 * read the source: the row is loaded scoped to the tenant first and the
 * decision is made from the employee on the row. Pinning a rule as a string
 * match is blunt, but the alternative here is mocking Prisma, and a mocked
 * client would have happily proved the old code correct.
 */

const SOURCE = readFileSync(path.resolve("src/services/performance/index.ts"), "utf8");

/** Comments stripped, so a comment about a rule cannot stand in for the rule. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function body(name: string): string {
  const start = CODE.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`performance/index.ts no longer exports ${name}`);
  const after = CODE.slice(start);
  const end = after.indexOf("\n}\n");
  return end === -1 ? after : after.slice(0, end);
}

function helper(name: string): string {
  const start = CODE.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`performance/index.ts no longer defines ${name}`);
  const after = CODE.slice(start);
  const end = after.indexOf("\n}\n");
  return end === -1 ? after : after.slice(0, end);
}

describe("editing a goal cannot reach another tenant", () => {
  const upsert = body("upsertGoal");

  it("never updates a goal by bare id", () => {
    // The defect, exactly as it read. If this comes back, so does the leak.
    expect(CODE).not.toMatch(/goal\.update\(\{\s*where:\s*\{\s*id:\s*input\.id\s*\}/);
    expect(CODE).not.toMatch(/prisma\.goal\.update\(/);
  });

  it("loads the row scoped to this organisation before touching it", () => {
    expect(upsert).toMatch(
      /goal\.findFirst\(\{[\s\S]*?where:\s*\{\s*id:\s*input\.id,\s*organizationId:\s*ctx\.organizationId\s*\}/,
    );
    expect(upsert).toMatch(/if \(!existing\) throw new NotFoundError/);
  });

  it("decides who may edit it from the row, not from the request", () => {
    // `input.employeeId` is caller-supplied and was the whole bug: sending your
    // own id let you through to somebody else's row.
    expect(upsert).toMatch(/existing\.employeeId !== ctx\.employeeId/);
    const decision = upsert.slice(upsert.indexOf("if (input.id)"), upsert.indexOf("} else {"));
    expect(decision).not.toMatch(/input\.employeeId/);
  });

  it("keeps the organisation on the write itself", () => {
    expect(upsert).toMatch(
      /goal\.updateMany\(\{\s*where:\s*\{\s*id:\s*existing\.id,\s*organizationId:\s*ctx\.organizationId\s*\}/,
    );
    expect(upsert).toMatch(/if \(updated\.count === 0\) throw new NotFoundError/);
  });

  it("does not let an edit move a goal to a different person", () => {
    // `data` is shared by both branches; an `employeeId` in it would make every
    // edit a potential reassignment.
    const data = upsert.slice(upsert.indexOf("const data = {"), upsert.indexOf("let goal"));
    expect(data).not.toMatch(/employeeId/);
  });

  it("resolves the employee before creating a goal for them", () => {
    // Creation had the same shape of hole: organizationId came from the session
    // while employeeId came from the request.
    const create = upsert.slice(upsert.indexOf("} else {"));
    expect(create).toMatch(/resolveGoalTargets\(ctx, \[input\.employeeId\]\)/);
    expect(create).toMatch(/if \(!target\) throw new NotFoundError/);
    expect(create).toMatch(/employeeId: target\.id/);
  });

  it("only accepts a cycle that belongs to this tenant", () => {
    expect(helper("resolveCycleId")).toMatch(
      /reviewCycle\.findFirst\(\{\s*where:\s*\{\s*id:\s*cycleId,\s*organizationId:\s*ctx\.organizationId\s*\}/,
    );
    expect(upsert).toMatch(/cycleId: await resolveCycleId\(ctx, input\.cycleId\)/);
  });
});

describe("who a goal may be set for", () => {
  const resolve = helper("resolveGoalTargets");

  it("asks the tenant and the visible scope, not just the permission", () => {
    expect(resolve).toMatch(/visibleEmployeeIds\(ctx, "employee\.read"\)/);
    expect(resolve).toMatch(/organizationId: ctx\.organizationId/);
  });

  it("reads null as no restriction", () => {
    // null means *no restriction*. Inverting it would stop every HR manager
    // from setting anybody a goal; that inversion has bitten this project.
    expect(resolve).toMatch(/visible !== null \? employeeIds\.filter/);
  });
});

describe("assigning one goal to several people", () => {
  const assign = body("assignGoal");

  it("is gated on the reviewing permission", () => {
    expect(assign).toMatch(/requireWrite\(ctx, "performance\.review", "performance"\)/);
  });

  it("still uses the shared plan, so the pure function is not decoration", () => {
    // planGoalAssignment is tested in src/domain/performance/goalAssignment.test.ts.
    // Pinning it there does not pin this caller, which is what this line is for.
    expect(assign).toMatch(/planGoalAssignment\(/);
    expect(assign).toMatch(/targets\.map\(\(t\) => t\.id\)/);
  });

  it("refuses the whole assignment when an id resolved to nobody", () => {
    expect(assign).toMatch(/plan\.unresolved\.length > 0/);
    expect(assign).toMatch(/throw new NotFoundError/);
    // The rows are written from the plan, never from the raw request.
    expect(assign).toMatch(/plan\.employeeIds\.map\(\(employeeId\) => \(\{/);
    expect(assign).not.toMatch(/input\.employeeIds\.map/);
  });

  it("writes the rows in one transaction", () => {
    // Half an assignment is the worst outcome: the admin is told it worked and
    // some of the team are never told about the goal.
    expect(assign).toMatch(/prisma\.\$transaction\(\[\s*prisma\.goal\.createMany/);
  });

  it("writes one audit row naming the count, not one per person", () => {
    expect(assign.match(/writeAudit\(/g) ?? []).toHaveLength(1);
    expect(assign).toMatch(/action: "goal\.assigned"/);
    expect(assign).toMatch(/employees: plan\.employeeIds\.length/);
  });

  it("tells each person, in one dispatch", () => {
    // Per person because "a goal was set for you" is only true of the reader —
    // the opposite judgement to the import's single summary to the HR desk.
    expect(assign).toMatch(/notify\.toUsers\(userIds/);
    expect(assign.match(/notify\./g) ?? []).toHaveLength(1);
  });
});

describe("the goal list says whose each goal is", () => {
  const list = body("listGoals");

  it("carries the employee on every row", () => {
    expect(list).toMatch(/employee: \{\s*id: g\.employee\.id/);
  });

  it("widens to the team only for somebody who reviews people", () => {
    expect(list).toMatch(/reviewsOthers = ctx\.permissions\.has\("performance\.review"\)/);
    expect(list).toMatch(/employeeId: \{ in: visible \}/);
    expect(list).toMatch(/organizationId: ctx\.organizationId/);
  });

  it("answers 404 for one person the viewer may not see", () => {
    expect(list).toMatch(/visible !== null && !visible\.includes\(employeeId\)/);
    expect(list).toMatch(/throw new NotFoundError\("That employee"\)/);
  });
});

describe("the roles this actually separates", () => {
  it("does not let an ordinary employee set anybody else a goal", () => {
    expect(ROLE_PERMISSIONS.TEAM_MEMBER as readonly string[]).not.toContain("performance.review");
  });

  it("lets the people who write the review set the goal it is judged against", () => {
    for (const role of ["TEAM_LEAD", "MANAGER", "HR_MANAGER", "ADMIN", "ORG_OWNER"] as const) {
      expect(ROLE_PERMISSIONS[role] as readonly string[]).toContain("performance.review");
    }
  });
});

describe("planGoalAssignment, as the service uses it", () => {
  it("turns a request naming a foreign id into a refusal, not a partial write", () => {
    const plan = planGoalAssignment(["ours", "theirs"], ["ours"]);
    expect(plan.unresolved).toEqual(["theirs"]);
  });
});
