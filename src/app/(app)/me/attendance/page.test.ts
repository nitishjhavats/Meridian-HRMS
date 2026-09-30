import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Seeing your attendance is not the same right as marking it.
 *
 * The page guards on `attendance.read.self` for exactly that reason, then
 * called `getTodayStatus`, which asks for `attendance.mark.self` the way
 * `markAttendance` does. Revoke "Check in and out" on somebody -- the
 * office-device-only case -- and My attendance threw into the error boundary:
 * no history, no corrections, and a sidebar link that kept pointing at it.
 */

const PAGE = "src/app/(app)/me/attendance/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/me/attendance without attendance.mark.self", () => {
  const body = code(PAGE);

  it("still reads, not marks, at the door", () => {
    expect(body).toMatch(/permission: "attendance\.read\.self"/);
  });

  it("asks for today's status only when marking is allowed", () => {
    expect(body).toMatch(/ctx\.permissions\.has\("attendance\.mark\.self"\)/);
    expect(body).toMatch(/canMark \? await getTodayStatus\(ctx\) : null/);
    // No unguarded call left behind.
    expect(body.match(/getTodayStatus\(ctx\)/g)).toHaveLength(1);
  });

  it("dates the header from the organisation's clock when there is no status", () => {
    expect(body).toMatch(/today\?\.date \?\? todayInZone\(timezone\)/);
  });

  it("explains the missing button rather than rendering a panel with no data", () => {
    expect(body).toMatch(/\{today \? \(\s*<CheckInPanel/);
    expect(body).toMatch(/<Alert tone="info" title="Attendance is marked at the office">/);
  });
});

describe("today's row while still at work", () => {
  it("is toned as in progress, and labelled by the domain", () => {
    const body = code(PAGE);
    const tones = body.slice(body.indexOf("const STATUS_TONE"), body.indexOf("};", body.indexOf("const STATUS_TONE")));
    expect(tones).toMatch(/CHECKED_IN: "info",/);
    expect(body).toMatch(/STATUS_LABELS\[day\.status\]/);
  });
});
