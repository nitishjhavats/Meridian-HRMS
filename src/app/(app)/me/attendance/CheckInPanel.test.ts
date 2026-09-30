import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Jivonik Ayurveda, 12-18 Sep 2026, on the live instance.
 *
 * Three check-outs 9-60 s after the check-in scored the day ABSENT with
 * nothing worked, and once the button had gone there was no way to check out
 * again when the person actually left. The GPS accuracy gate (35 m at a 300 m
 * radius) turned away old phones standing at the counter and recorded
 * nothing. And a check-in was read back as "half day" from the moment
 * somebody arrived. Each of those is a line in this file, and each guard here
 * is what stops it coming back.
 */

const PANEL = "src/app/(app)/me/attendance/CheckInPanel.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the check-in panel after a check-out", () => {
  const body = code(PANEL);

  it("no longer gates the button on being finished", () => {
    expect(body).not.toMatch(/\bfinished\b/);
    expect(body).toMatch(/const ready = !busy && !geoBlocked && !cameraBlocked;/);
    expect(body).toMatch(/const canSubmit = ready && !checkoutTooSoon;/);
  });

  it("waits out the server's five minutes instead of uploading a burst for a certain refusal", () => {
    // The domain's number, not a copy of it.
    expect(body).toMatch(/MIN_MINUTES_BEFORE_CHECKOUT,\s*STATUS_LABELS,/);
    expect(body).not.toMatch(/minutesSinceCheckIn < 5\b/);
    expect(body).toMatch(
      /const checkoutTooSoon =\s*openDay && minutesSinceCheckIn !== null && minutesSinceCheckIn < MIN_MINUTES_BEFORE_CHECKOUT;/,
    );
    // The button, and the line under it that says when.
    expect(body).toMatch(/disabled=\{!canSubmit\}/);
    expect(body).toMatch(/MIN_MINUTES_BEFORE_CHECKOUT \* 60_000/);
    expect(body).toMatch(/Check out is available from \$\{checkoutOpensAt\}\./);
    const explanation = body.slice(body.indexOf("{!canSubmit && !busy ?"));
    expect(explanation.indexOf("checkoutTooSoon")).toBeGreaterThan(-1);
    expect(explanation.indexOf("checkoutTooSoon")).toBeLessThan(explanation.indexOf("accuracyTooLow"));
  });

  it("says 'just now' rather than '0 min ago'", () => {
    expect(body).toMatch(/minutesSinceCheckIn === 0\s*\?\s*" · You checked in just now"/);
    expect(body).toMatch(/"You checked in just now\."/);
  });

  it("keeps the camera running until the panel goes away", () => {
    // The only stop is the unmount effect; nothing stops it on a check-out.
    expect(body).toMatch(/useEffect\(\(\) => stopCamera, \[stopCamera\]\);/);
    expect(body).not.toMatch(/checkedOutAt\) stopCamera\(\)/);
    expect(body.match(/stopCamera\(\)/g) ?? []).toHaveLength(0);
  });

  it("says what happened and what is next, in three states", () => {
    expect(body).toMatch(/Checked in at \{formatTime\(status\.checkedInAt\)\}/);
    expect(body).toMatch(/Check out when you leave/);
    expect(body).toMatch(/You checked in \$\{minutesSinceCheckIn\} min ago/);
    expect(body).not.toMatch(/You checked in 0 min ago/);
    expect(body).toMatch(/`Checked out at \$\{formatTime\(status\.checkedOutAt\)\}`/);
    expect(body).toMatch(/\{formatDuration\(status\.workedMinutes\)\} recorded/);
    expect(body).toMatch(/Checked out too early by mistake\? Check out again when you actually leave/);
    expect(body).toMatch(/the later time counts/);
  });

  it("names the status from the domain rather than un-snaking the enum", () => {
    expect(body).toMatch(
      /import \{\s*MIN_MINUTES_BEFORE_CHECKOUT,\s*STATUS_LABELS,\s*type AttendanceStatus,\s*\} from "@\/domain\/attendance\/policy";/,
    );
    expect(body).toMatch(/STATUS_LABELS\[status\.status as AttendanceStatus\]/);
    expect(body).not.toMatch(/status\.status\.replaceAll/);
  });

  it("counts the minutes from a clock read only on the client", () => {
    expect(body).toMatch(/useState<number \| null>\(null\)/);
    expect(body).toMatch(/if \(geo\.kind !== "ready" && !openDay\) return;/);
  });
});

describe("re-verifying a flagged check-in from the phone", () => {
  const body = code(PANEL);
  const inReview = code("src/app/(app)/me/attendance/InReview.tsx");

  it("carries which mark is waiting, optionally, so the panel compiles either way", () => {
    expect(body).toMatch(/pendingReview\?: "CHECK_IN" \| "CHECK_OUT" \| null;/);
  });

  it("offers Retake photo only for a pending check-in that has not been checked out", () => {
    expect(body).toMatch(
      /const canRetake =\s*status\.pendingReview === "CHECK_IN" && status\.checkedOutAt === null && status\.requireSelfie;/,
    );
    expect(body).toMatch(/\{canRetake \? \(/);
    expect(body).toMatch(/Retake photo/);
  });

  it("submits the retake as a CHECK_IN explicitly, not as whatever the big button does", () => {
    expect(body).toMatch(
      /async function submit\(acceptForReview = false, type: "CHECK_IN" \| "CHECK_OUT" = action\)/,
    );
    expect(body).toMatch(/form\.set\("type", type\);/);
    expect(body).not.toMatch(/form\.set\("type", action\);/);
    expect(body).toMatch(/onClick=\{\(\) => void submit\(false, "CHECK_IN"\)\}/);
  });

  it("is not held to the five-minute wait, because nothing is being checked out", () => {
    const retake = body.slice(body.indexOf("{canRetake ? ("), body.indexOf("Retake photo"));
    expect(retake).toMatch(/disabled=\{!ready\}/);
    expect(retake).not.toMatch(/canSubmit/);
  });

  it("retries the refused attempt's own type from the dialog", () => {
    expect(body).toMatch(/setFailedType\(type\);/);
    expect(body).toMatch(/void submit\(false, failedType\);/);
    expect(body).toMatch(/void submit\(true, failedType\);/);
    // The bare calls would retry a retake as a check-out.
    expect(body).not.toMatch(/void submit\(\);\s*\}\}\s*disabled=\{busy\}/);
  });

  it("names the button the in-review card points at", () => {
    expect(inReview).toMatch(/tap Retake photo on the check-in card/);
    expect(inReview).not.toMatch(/press the same button again/);
    // The PIN path stays.
    expect(inReview).toMatch(/six-digit code/);
  });

  it("keeps the way back from an early check-out", () => {
    expect(body).toMatch(/Check out again when you actually leave/);
    expect(body).toMatch(/the later time counts/);
  });
});

describe("the face refusal dialog", () => {
  const body = code(PANEL);

  it("names somebody else in the frame, as the kiosk does", () => {
    const title = body.slice(body.indexOf("<DialogTitle>"), body.indexOf("</DialogTitle>"));
    expect(title).toMatch(/faceFailure === "MULTIPLE_FACES"\s*\?\s*"Somebody else is as close to the camera"/);
    expect(body).toMatch(/Step apart so only you are in the frame, then retry\./);
  });
});

describe("the check-in panel and GPS accuracy", () => {
  const body = code(PANEL);

  it("carries the server's limit, nullable, into the same geofence check", () => {
    expect(body).toMatch(/maxAccuracyMeters: number \| null;/);
    expect(body).toMatch(/\{ maxAccuracyMeters: status\.maxAccuracyMeters \}/);
  });

  it("reads the accuracy the server recorded for each mark", () => {
    expect(body).toMatch(/events: \{ type: string; distanceMeters: number \| null; accuracyMeters: number \| null \}\[\];/);
    expect(body).toMatch(/GPS ±\$\{lastMarkAccuracy\} m/);
  });

  it("quotes a limit only when there is one", () => {
    expect(body).toMatch(/`GPS ±\$\{Math\.round\(geo\.coords\.accuracy\)\} m\$\{/);
    expect(body).toMatch(/status\.maxAccuracyMeters !== null\s*\?\s*` \(needs ±\$\{status\.maxAccuracyMeters\} m or better\)`/);
  });

  it("tells a refused reading apart from a real distance", () => {
    expect(body).toMatch(/const accuracyTooLow = fence\?\.reason === "ACCURACY_TOO_LOW";/);
    expect(body).toMatch(/const outsideFence = fence\?\.reason === "OUTSIDE_RADIUS";/);
    // The old shape, which made an accuracy refusal read as "you are outside".
    expect(body).not.toMatch(/const outsideFence = fence !== null && !fence\.ok;/);
    // And the refusal is explained as a reading, before the distance line.
    const explanation = body.slice(body.indexOf("{!canSubmit && !busy ?"));
    expect(explanation.indexOf("accuracyTooLow")).toBeGreaterThan(-1);
    expect(explanation.indexOf("accuracyTooLow")).toBeLessThan(explanation.indexOf("You are outside"));
  });

  it("warns about a guessed reading only when the organisation refuses it", () => {
    const warning = body.indexOf("Your phone is guessing from Wi-Fi");
    expect(warning).toBeGreaterThan(-1);
    expect(body.slice(warning - 200, warning)).toMatch(/accuracyTooLow \? \(/);
  });

  it("hints, without blocking, when the reading is wider than the fence", () => {
    expect(body).toMatch(/geo\.coords\.accuracy > status\.location\.radiusMeters/);
    expect(body).toMatch(/Your phone&apos;s reading is rough \(±\{Math\.round\(geo\.coords\.accuracy\)\} m\)\./);
    expect(body).toMatch(/If the distance looks wrong, step outside for a moment\./);
    // Not part of the gate.
    expect(body).not.toMatch(/roughReading\)/);
    expect(body).toMatch(/\(status\.noWorkLocation \|\| geo\.kind !== "ready" \|\| fixStale \|\| fenceRefused\)/);
  });
});
