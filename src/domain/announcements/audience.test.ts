import { describe, expect, it } from "vitest";
import { type Viewer, describeAudience, isLive, isVisibleTo, parseAudience } from "./audience";

const viewer = (overrides: Partial<Viewer> = {}): Viewer => ({
  role: "TEAM_MEMBER",
  employeeId: "emp1",
  departmentId: "dept1",
  workLocationId: "loc1",
  ...overrides,
});

describe("parseAudience", () => {
  it("defaults to everyone when the stored value is unusable", () => {
    expect(parseAudience(null).scope).toBe("ALL");
    expect(parseAudience({ scope: "NONSENSE" }).scope).toBe("ALL");
    expect(parseAudience("not an object").scope).toBe("ALL");
  });

  it("drops non-string entries rather than trusting the JSON", () => {
    const audience = parseAudience({ scope: "DEPARTMENT", departmentIds: ["a", 7, null] });
    expect(audience.departmentIds).toEqual(["a"]);
  });
});

describe("isVisibleTo", () => {
  it("shows an ALL announcement to anyone, even someone with no employee record", () => {
    const nobody = viewer({ employeeId: null, departmentId: null, workLocationId: null });
    expect(isVisibleTo({ scope: "ALL" }, nobody)).toBe(true);
  });

  it("matches by department", () => {
    const audience = { scope: "DEPARTMENT" as const, departmentIds: ["dept1"] };
    expect(isVisibleTo(audience, viewer())).toBe(true);
    expect(isVisibleTo(audience, viewer({ departmentId: "dept2" }))).toBe(false);
    expect(isVisibleTo(audience, viewer({ departmentId: null }))).toBe(false);
  });

  it("matches by role", () => {
    const audience = { scope: "ROLE" as const, roles: ["ADMIN", "HR_MANAGER"] };
    expect(isVisibleTo(audience, viewer({ role: "HR_MANAGER" }))).toBe(true);
    expect(isVisibleTo(audience, viewer())).toBe(false);
  });

  it("matches named employees", () => {
    const audience = { scope: "EMPLOYEES" as const, employeeIds: ["emp1", "emp9"] };
    expect(isVisibleTo(audience, viewer())).toBe(true);
    expect(isVisibleTo(audience, viewer({ employeeId: "emp5" }))).toBe(false);
  });

  it("shows nothing when a targeted audience names no one", () => {
    // An empty list is a mistake, but it must not silently become "everyone".
    expect(isVisibleTo({ scope: "DEPARTMENT", departmentIds: [] }, viewer())).toBe(false);
  });
});

describe("isLive", () => {
  const now = new Date("2026-06-15T10:00:00Z");

  it("hides an unpublished announcement", () => {
    expect(isLive({ published: false, publishAt: new Date("2026-01-01"), expiresAt: null }, now)).toBe(false);
  });

  it("hides one scheduled for later", () => {
    expect(isLive({ published: true, publishAt: new Date("2026-07-01"), expiresAt: null }, now)).toBe(false);
  });

  it("hides one that has expired", () => {
    expect(
      isLive({ published: true, publishAt: new Date("2026-01-01"), expiresAt: new Date("2026-06-01") }, now),
    ).toBe(false);
  });

  it("shows a current one", () => {
    expect(
      isLive({ published: true, publishAt: new Date("2026-06-01"), expiresAt: new Date("2026-12-01") }, now),
    ).toBe(true);
  });
});

describe("describeAudience", () => {
  it("names departments rather than showing ids", () => {
    const names = { departments: new Map([["dept1", "Engineering"]]) };
    expect(describeAudience({ scope: "DEPARTMENT", departmentIds: ["dept1"] }, names)).toBe("Engineering");
  });

  it("summarises a long list instead of printing all of it", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(describeAudience({ scope: "EMPLOYEES", employeeIds: ids })).toBe("a, b, c and 2 more");
  });

  it("says plainly when it is everyone", () => {
    expect(describeAudience({ scope: "ALL" })).toBe("Everyone in the organisation");
  });
});
