import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canEnforceFence,
  primarySwitch,
  resolveWorkLocationId,
  type WorkLocationChoice,
} from "./defaultWorkLocation";

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const loc = (over: Partial<WorkLocationChoice> & { id: string }): WorkLocationChoice => ({
  active: true,
  isPrimary: false,
  createdAt: at("2026-01-01"),
  ...over,
});

describe("resolveWorkLocationId", () => {
  it("uses what the form chose", () => {
    const chosen = resolveWorkLocationId([loc({ id: "a" }), loc({ id: "b" })], "b");
    expect(chosen).toBe("b");
  });

  it("falls back to the primary branch when nothing was chosen", () => {
    const locations = [
      loc({ id: "a", createdAt: at("2025-01-01") }),
      loc({ id: "b", isPrimary: true, createdAt: at("2026-06-01") }),
    ];
    // The primary wins even though it is the newer row — that is the whole
    // point of marking one.
    expect(resolveWorkLocationId(locations)).toBe("b");
    expect(resolveWorkLocationId(locations, null)).toBe("b");
    expect(resolveWorkLocationId(locations, "")).toBe("b");
  });

  it("falls back to the oldest active branch when none is primary", () => {
    const locations = [
      loc({ id: "new", createdAt: at("2026-06-01") }),
      loc({ id: "old", createdAt: at("2024-02-02") }),
    ];
    expect(resolveWorkLocationId(locations)).toBe("old");
  });

  it("never defaults somebody into a branch that is switched off", () => {
    const locations = [
      loc({ id: "closed", active: false, isPrimary: true, createdAt: at("2024-01-01") }),
      loc({ id: "open", createdAt: at("2026-01-01") }),
    ];
    // A closed branch marked primary is a leftover, and defaulting into it
    // would give the employee a fence the server refuses to measure against.
    expect(resolveWorkLocationId(locations)).toBe("open");
  });

  it("returns null when the organisation has no active branch", () => {
    expect(resolveWorkLocationId([])).toBeNull();
    expect(resolveWorkLocationId([loc({ id: "closed", active: false })])).toBeNull();
  });

  it("hands back an unknown id unchanged rather than silently reassigning", () => {
    // Swapping it for a default would move somebody to another branch without
    // anybody asking. The caller's tenant check is what refuses it.
    expect(resolveWorkLocationId([loc({ id: "a" })], "someone-elses")).toBe("someone-elses");
  });
});

describe("primarySwitch", () => {
  it("clears every other primary", () => {
    const locations = [
      loc({ id: "a", isPrimary: true }),
      loc({ id: "b", isPrimary: true }),
      loc({ id: "c" }),
    ];
    expect(primarySwitch(locations, "c")).toEqual({
      markPrimary: "c",
      clearPrimary: ["a", "b"],
    });
  });

  it("does not clear the one being marked", () => {
    const locations = [loc({ id: "a", isPrimary: true })];
    expect(primarySwitch(locations, "a")).toEqual({ markPrimary: "a", clearPrimary: [] });
  });
});

describe("canEnforceFence", () => {
  it("is false with no branch and false with only closed ones", () => {
    expect(canEnforceFence([])).toBe(false);
    expect(canEnforceFence([loc({ id: "a", active: false })])).toBe(false);
  });

  it("is true as soon as one branch is open", () => {
    expect(canEnforceFence([loc({ id: "a", active: false }), loc({ id: "b" })])).toBe(true);
  });
});

/**
 * Pinning a pure function pins nothing if its caller stops asking it — the
 * lesson this codebase has learned more than once.
 */
describe("the create path actually uses it", () => {
  const WRITE = readFileSync(path.resolve("src/services/employees/write.ts"), "utf8");
  const CODE = WRITE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("resolves a work location when creating an employee", () => {
    expect(CODE).toMatch(/resolveWorkLocationId\(/);
  });

  it("does not do it on update, where a blank means 'clear it'", () => {
    // On create, absent means "nobody chose"; on update, absent means "leave it"
    // and an explicit null means "remove it". Defaulting there would make it
    // impossible to take somebody off a branch.
    const update = CODE.slice(CODE.indexOf("export async function updateEmployee("));
    expect(update).not.toMatch(/resolveWorkLocationId\(/);
  });
});

/**
 * The importer walked straight past the default.
 *
 * `createEmployee` fills a blank work location from the primary branch — that
 * is the whole of the geofence fix, because an employee with no work location
 * has no distance measured for them and can mark attendance from any address in
 * the world. The CSV importer calls `insertEmployee` directly, so a blank
 * "Work Location" cell resolved to `null` and stayed `null`. A file of fifty
 * people imported without that column was fifty people outside the fence.
 */
describe("every path that creates an employee applies the default", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("the form does", () => {
    expect(strip(read("src/services/employees/write.ts"))).toMatch(/resolveWorkLocationId\(/);
  });

  it("the importer does", () => {
    const code = strip(read("src/services/employees/import.ts"));
    expect(code).toMatch(/resolveWorkLocationId\(locations, row\.employee!\.workLocationId\)/);
    // Resolved once for the file rather than per row: a hundred rows must not
    // be a hundred queries inside one transaction. Outside the loop, before it.
    const loaded = code.indexOf("const locations = await prisma.workLocation.findMany");
    const transaction = code.indexOf("prisma.$transaction(async (tx)");
    expect(loaded).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(loaded).toBeLessThan(transaction);
  });

  it("the setup checklist asks the organisation's own rule before promising anything", () => {
    /**
     * It asserted flatly that nobody can mark attendance without a work
     * location. That is true only where `requireWorkLocation` is on. Measured
     * on production while writing this: it is on for one organisation and
     * **off** for the other two, which have no work location either — so on
     * those two the sentence told an administrator they were safe while
     * everybody marked attendance from wherever they were standing.
     *
     * Both outcomes are real, so the step reads the rule and says whichever is
     * true rather than picking one and being wrong half the time.
     */
    const code = strip(read("src/services/org/setup.ts"));
    expect(code).toMatch(/getAttendanceRules\(ctx\)/);
    expect(code).toMatch(/const requireWorkLocation = attendance\.requireWorkLocation;/);
    expect(code).toMatch(/why: requireWorkLocation/);
    // Both sentences present, neither unconditional.
    expect(code).toMatch(/Nobody can mark attendance until there is one/);
    expect(code).toMatch(/marked from any address in the world/);
  });
});
