import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as kiosk from "./kiosk";
import { PERMISSIONS, ROLE_PERMISSIONS, effectivePermissions } from "@/lib/auth/permissions";

/**
 * What a shared screen in a reception area is allowed to be.
 *
 * A kiosk is the one login in this product that nobody owns, that stands
 * unattended in a public room, and whose password is written on a card in a
 * drawer. Its safety rests on three decisions that are each a single line of
 * code, and each of which would keep working — silently and wrongly — if that
 * line were changed:
 *
 *   1. face matching is forced on, whatever the organisation has configured,
 *   2. the role's permission set is exhaustive, because grants are refused,
 *   3. nothing else in the product holds the two kiosk permissions.
 *
 * None of these needs a database, and testing them against one would test the
 * seed instead of the decision.
 */

const SOURCE = readFileSync(path.resolve("src/services/attendance/kiosk.ts"), "utf8");

describe("face matching is not the organisation's choice here", () => {
  it("overrides the configured mode rather than reading it", () => {
    // On a personal phone the login already proves who you are. On a shared
    // screen it proves nothing but which room the device is in, so an
    // organisation that set face matching to OFF or OPTIONAL still gets
    // REQUIRED at the kiosk.
    expect(SOURCE).toMatch(/\.\.\.rules\.faceMatch,\s*\n\s*mode: "REQUIRED"/);
  });

  it("blocks somebody who has never enrolled instead of waving them through", () => {
    // `whenNotEnrolled` defaulting to ALLOW would turn the override above into
    // decoration for every employee without a reference photo.
    expect(SOURCE).toMatch(/whenNotEnrolled: "BLOCK"/);
  });
});

describe("the kiosk role's permissions are exhaustive", () => {
  it("holds exactly the two it needs", () => {
    expect([...ROLE_PERMISSIONS.KIOSK].sort()).toEqual([
      "attendance.kiosk.operate",
      "attendance.mark.kiosk",
    ]);
  });

  it("cannot be widened by a per-user grant", () => {
    // The mechanism that would quietly widen a device nobody is watching.
    const withGrants = effectivePermissions("KIOSK", [
      { permission: "employee.read", granted: true },
      { permission: "payroll.read", granted: true },
      { permission: "chat.use", granted: true },
      { permission: "platform.org.read", granted: true },
    ]);
    expect([...withGrants].sort()).toEqual([
      "attendance.kiosk.operate",
      "attendance.mark.kiosk",
    ]);
  });

  it("holds nothing that reads a person's record", () => {
    const held = ROLE_PERMISSIONS.KIOSK as readonly string[];
    const reading = held.filter((p) =>
      /^(employee|payroll|leave|document|letter|report|audit|chat)\./.test(p),
    );
    expect(reading).toEqual([]);
  });
});

describe("only a kiosk operates a kiosk", () => {
  it("gives `attendance.kiosk.operate` to no other role", () => {
    const holders = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]).filter(
      (role) => (ROLE_PERMISSIONS[role] as readonly string[]).includes("attendance.kiosk.operate"),
    );
    // Not even ORG_OWNER. An owner who wants the kiosk screen signs the device
    // in; the alternative is an admin marking attendance as somebody else from
    // their own laptop, which is the fraud the selfie exists to prevent.
    expect(holders).toEqual(["KIOSK"]);
  });

  it("guards both entry points with a permission that exists", () => {
    expect(PERMISSIONS).toContain("attendance.kiosk.operate");
    expect(PERMISSIONS).toContain("attendance.mark.kiosk");
    // Reading the roster and marking somebody present are separate permissions
    // on purpose; the guards must not have drifted onto the same one.
    expect(SOURCE).toMatch(/requirePermission\(ctx, "attendance\.kiosk\.operate"\)/);
    expect(SOURCE).toMatch(/requirePermission\(ctx, "attendance\.mark\.kiosk"\)/);
  });
});

describe("the module's surface", () => {
  it("exposes no way to mark attendance without going through the kiosk guard", () => {
    // Every exported function that writes must be one of these two; a new
    // export that skips `requirePermission` would not fail any other test.
    const writers = Object.keys(kiosk).filter((name) => /^(mark|issue|set|create|delete)/.test(name));
    expect(writers.sort()).toEqual(["issueAttendancePin", "markAtKiosk"]);
  });
});

/**
 * The door that was open behind all of it.
 *
 * A PIN marks attendance with no photo at all — it is the deliberate manual
 * override, and it records the day as unverified. Everything the face system
 * does is downstream of who may issue one.
 */
describe("nobody issues themselves a way past their own face", () => {
  const SOURCE = readFileSync(path.resolve("src/services/attendance/kiosk.ts"), "utf8");
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const issue = CODE.slice(
    CODE.indexOf("export async function issueAttendancePin("),
    CODE.indexOf("export async function redeemPin(") === -1
      ? undefined
      : CODE.indexOf("export async function redeemPin("),
  );

  it("refuses a self-issued PIN before consulting the team fallback", () => {
    // `teamEmployeeIds` seeds its set with the caller (lib/auth/guard.ts), so
    // the fallback used to match an ordinary employee asking for their own
    // code. Every employee with a login could skip the face match, the blink
    // and the geofence in one request.
    expect(issue).toMatch(/ctx\.employeeId === employeeId/);
    // Before the authority check, not inside its else-branch: an administrator
    // could issue their own until this moved.
    expect(issue.indexOf("if (forSelf)")).toBeGreaterThan(-1);
    expect(issue.indexOf("if (forSelf)")).toBeLessThan(issue.indexOf("await mayIssuePin(ctx)"));
  });

  it("still lets a manager issue one for somebody they manage", () => {
    // The commonest honest case, and somebody is standing there watching.
    expect(issue).toMatch(/teamEmployeeIds\(ctx\)/);
    expect(issue).toMatch(/team\.includes\(employeeId\)/);
  });

  it("keeps the named authorities as the first way in", () => {
    expect(issue).toMatch(/await mayIssuePin\(ctx\)/);
  });
});

describe("a shared device softens nothing", () => {
  const SOURCE = readFileSync(path.resolve("src/services/attendance/kiosk.ts"), "utf8");

  it("forces every field of the face policy, not two of them", () => {
    // It hardened `mode` and `whenNotEnrolled` and inherited the rest, so an
    // admin switching the blink off on the settings screen switched it off on
    // the wall-mounted device too — and a printed photo passed there.
    const override = SOURCE.slice(
      SOURCE.indexOf("evaluateFaceMatch(candidate, references, {"),
      SOURCE.indexOf("// Stored either way"),
    );
    expect(override).toMatch(/mode: "REQUIRED"/);
    expect(override).toMatch(/whenNotEnrolled: "BLOCK"/);
    expect(override).toMatch(/requireBlink: true/);
    expect(override).toMatch(/rejectMultipleFaces: true/);
    // Never below the shipped threshold, and an organisation may still raise it.
    expect(override).toMatch(/Math\.max\(rules\.faceMatch\.threshold/);
  });

  it("checks the marking window before it uploads anything", () => {
    const mark = SOURCE.slice(SOURCE.indexOf("export async function markAtKiosk("));
    const window = mark.indexOf("isWithinMarkingWindow(rules, local.minutes)");
    const upload = mark.indexOf("storage().put(selfieKey");
    expect(window).toBeGreaterThan(-1);
    // A refusal after the upload leaves a stored object nobody will ever read.
    expect(upload).toBeGreaterThan(window);
  });
});

/**
 * The roster and the buttons on it have to agree about who exists.
 *
 * Reported as "kiosk pe Nikita ka calendar kyu nahi load ho raha", and it was
 * not about Nikita. `getKioskRoster` listed every active employee in the
 * organisation; `getKioskMonth` scoped to the device's *own work location*. So
 * the screen drew a Calendar button on every card and the route answered "That
 * person" for anybody registered at another branch — a 404 that reads as a
 * broken feature rather than as a refusal, because the button should not have
 * been there at all.
 *
 * **This block used to forbid per-branch scoping outright**, which was the
 * wrong lesson drawn from the right incident. The bug was never that a device
 * knew about its branch; it was that two queries disagreed. A branch is now a
 * setting an administrator chooses per device — and the way that stays safe is
 * that all three predicates come from `rosterScope`, so there is one answer to
 * "who is on this screen" and the roster, the calendar and the mark all read
 * it.
 *
 * The failure this guards against is silent, which is why it is asserted on the
 * source: two correct-looking queries that quietly differ.
 */
describe("what the roster shows, the per-person routes answer for", () => {
  it("declares the roster scope once", () => {
    expect(SOURCE).toMatch(/function rosterScope\(organizationId: string, branch\?: string \| null\)/);
  });

  it("the roster and the month route both use it", () => {
    // Three at least: the declaration, the list, and the per-person lookup. A
    // month route that built its own `where` is exactly the original bug.
    const uses = SOURCE.match(/rosterScope\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it("and both read the branch from the same place", () => {
    // `deviceBranch` is the only thing that turns a device's setting into a
    // filter. Two call sites reading the column directly is how they drift.
    const uses = SOURCE.match(/deviceBranch\(ctx\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("marking is narrowed too, so the setting is a boundary and not a tidier list", () => {
    // The roster is the only way to reach the mark route through the screen,
    // but a route is reachable without a screen. A device limited to one branch
    // refuses a mark for somebody at another.
    expect(SOURCE).toMatch(/device\.rosterScope === "WORK_LOCATION" \? device\.workLocation\.id : null/);
  });

  it("a device set to the whole organisation still sees the whole organisation", () => {
    // The migration leaves every existing device on ORGANISATION, and this is
    // what makes that a no-op: `branch` is null and the predicate is unchanged.
    expect(SOURCE).toMatch(/rosterScope: true, workLocationId: true/);
    expect(SOURCE).toMatch(/\.\.\.\(branch \? \{ workLocationId: branch \} : \{\}\)/);
  });

  it("nothing rebuilds the predicate by hand", () => {
    // The original defect in one line: an inline copy that drifted from the
    // shared one. The employment filter lives in `OFF_ROSTER` and nowhere else.
    expect(SOURCE).not.toMatch(/employmentState: \{ notIn: \["RESIGNED"/);
  });

  it("still refuses somebody in another organisation, and calls it a 404", () => {
    // The scope narrows to a branch; it never widens past the organisation. A
    // cross-tenant read is a not-found, never a forbidden — a device that can
    // tell "no such person" from "not yours" leaks the roster next door.
    expect(SOURCE).toMatch(/rosterScope\(ctx\.organizationId!, await deviceBranch\(ctx\)\)/);
    expect(SOURCE).toMatch(/if \(!onRoster\) throw new NotFoundError/);
  });

  it("the screen says when it is showing only one branch", () => {
    // A person who cannot find their name must be told why, or the last bug is
    // reported again in a different shape.
    const screen = readFileSync(path.resolve("src/app/kiosk/KioskScreen.tsx"), "utf8");
    expect(screen).toMatch(/device\.rosterScope === "WORK_LOCATION"/);
    expect(screen).toMatch(/Showing people who work at/);
  });

  it("the roster does not borrow getKioskContext to find its branch", () => {
    /**
     * `getKioskContext` writes `lastSeenAt` on every call and throws when the
     * bound location has been switched off. The roster is polled continuously,
     * so borrowing it would turn every poll into a write and turn one
     * deactivated location into a 403 where there used to be a list.
     */
    const roster = SOURCE.slice(
      SOURCE.indexOf("export async function getKioskRoster"),
      SOURCE.indexOf("export async function markAtKiosk"),
    );
    expect(roster).not.toMatch(/getKioskContext\(/);
  });
});

describe("the reception screen does not go stale on the wall", () => {
  const SCREEN = readFileSync(path.resolve("src/app/kiosk/KioskScreen.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("re-reads the roster on a timer, on focus, and after a failed mark", () => {
    // Left on overnight, it offered "check out" to everybody who had marked
    // the day before, and the server refused each of them the next morning.
    expect(SCREEN).toMatch(/ROSTER_REFRESH_MS/);
    expect(SCREEN).toMatch(/addEventListener\("visibilitychange", onVisible\)/);
    expect(SCREEN).toMatch(/setError\(message\);\s*void refresh\(\);/);
  });

  it("treats a 401/403/404 from the roster as a reason to reload, not to keep the old list", () => {
    expect(SCREEN).toMatch(/response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 404/);
    expect(SCREEN).toMatch(/window\.location\.href = "\/kiosk"/);
  });

  it("adopts a new worker only between people", () => {
    expect(SCREEN).toMatch(/if \(stageRef\.current\.kind !== "roster" \|\| busyRef\.current\) return;/);
  });
});
