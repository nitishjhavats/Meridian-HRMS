import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The GPS accuracy gate is a switch now, and the switch has to be on the
 * screen. It was a constant applied to every check-in with no control
 * anywhere in the product -- which is how it went on turning away old phones
 * at one organisation's counter with nobody able to see it, let alone turn it
 * off. The form binds both halves of `gpsAccuracy` and sends the whole policy
 * through the domain schema, so nothing here can drop the field on the way.
 */

const FORM = "src/app/(app)/settings/attendance/AttendanceSettingsForm.tsx";
const SERVICE = "src/services/attendance/settings.ts";
const ROUTE = "src/app/api/settings/attendance/route.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the accuracy gate on the attendance settings screen", () => {
  const body = code(FORM);

  it("binds the switch to gpsAccuracy.enforce", () => {
    expect(body).toMatch(/title="Require an accurate GPS fix"/);
    expect(body).toMatch(/checked=\{policy\.gpsAccuracy\.enforce\}/);
    expect(body).toMatch(/set\("gpsAccuracy", \{ \.\.\.policy\.gpsAccuracy, enforce: v \}\)/);
  });

  it("says what each position does, and who cannot meet it", () => {
    expect(body).toMatch(
      /Off: only the distance to the branch decides\. On: a reading coarser than the limit is refused\. Older phones often cannot meet it\./,
    );
  });

  it("binds the limit to gpsAccuracy.maxMeters, 5-500, only while on", () => {
    expect(body).toMatch(/label="Accuracy limit"/);
    expect(body).toMatch(/value=\{policy\.gpsAccuracy\.maxMeters\}/);
    expect(body).toMatch(/min=\{5\}/);
    expect(body).toMatch(/max=\{500\}/);
    expect(body).toMatch(/disabled=\{!canWrite \|\| !policy\.gpsAccuracy\.enforce\}/);
    expect(body).toMatch(/error=\{issues\.get\("gpsAccuracy\.maxMeters"\)\}/);
    expect(body).toMatch(/set\("gpsAccuracy", \{ \.\.\.policy\.gpsAccuracy, maxMeters: v \}\)/);
  });

  it("sends the whole policy, so the field cannot be left behind", () => {
    expect(body).toMatch(/body: \{ policy, faceMatch, effectiveFrom \}/);
  });
});

describe("the policy on its way to the database", () => {
  it("is parsed whole by the domain schema, with no field list of its own", () => {
    const service = code(SERVICE);
    expect(service).toMatch(/attendancePolicySchema\.safeParse\(input\.policy\)/);
    expect(service).not.toMatch(/gpsAccuracy/);
    const route = code(ROUTE);
    expect(route).toMatch(/policy: z\.unknown\(\)/);
    expect(route).not.toMatch(/gpsAccuracy/);
  });
});
