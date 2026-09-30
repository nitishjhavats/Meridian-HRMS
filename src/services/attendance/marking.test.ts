import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The two mark paths, held to the same promises.
 *
 * Source assertions, because what is being pinned is control flow through a
 * function that needs a database, a storage adapter and two ONNX sessions to
 * run. The pure decision it hangs on -- `evaluateFaceMatch` -- is tested
 * directly in `domain/attendance/faceMatch.test.ts`; pinning that function does
 * not pin its callers, and the callers are where this round's behaviour lives.
 *
 * The behaviour, in one sentence: **marking must not be able to fail forever.**
 * It could, and it did. On the live instance one employee's check-out was
 * refused fourteen consecutive times in a single morning and never went
 * through; her day is still recorded as half a day.
 */

const PHONE = "src/services/attendance/checkIn.ts";
const KIOSK = "src/services/attendance/kiosk.ts";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

/** Comments quote the code they describe, so a guard must not read them. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("a person who has tried enough times may mark anyway", () => {
  for (const [name, file] of Object.entries({ phone: PHONE, kiosk: KIOSK })) {
    it(`${name}: honours the escape`, () => {
      expect(code(file)).toMatch(/input\.acceptForReview/);
    });

    it(`${name}: only where the policy leaves a way out`, () => {
      // `reviewAfterAttempts` is `null` under `onMismatch: "BLOCK"`. Without
      // this condition the escape would quietly defeat a setting whose entire
      // purpose is to be a closed door.
      expect(code(file)).toMatch(/reviewAfterAttempts !== null/);
    });

    it(`${name}: and the mark it makes is always flagged`, () => {
      // The escape buys somebody their morning. It must not buy them a verified
      // attendance record, or an organisation would find that the strictest
      // setting it has is a button away from nothing.
      expect(code(file)).toMatch(/(flagForReview:|flagged =)\s*true/);
    });

    it(`${name}: tells the screen how many tries are left`, () => {
      // Without the number the screen cannot know when to offer the button, and
      // guessing it client-side would drift from the server the first time the
      // policy changed.
      expect(code(file)).toMatch(/reviewAfterAttempts:/);
    });
  }
});

describe("a second photo re-checks the mark instead of colliding with it", () => {
  /**
   * The bug this exists to prevent, and it is the one the round created.
   *
   * The moment a doubted mark is *recorded* rather than refused, retrying stops
   * working: `recordAttendance` sees a check-in time already on the day and
   * throws "You already checked in at 09:14". A person told their mark went
   * through and then told they cannot try again is worse off than before.
   */
  it("looks for a mark that is still waiting before writing a new one", () => {
    const phone = code(PHONE);
    const pending = phone.indexOf("findPendingMark(");
    const record = phone.indexOf("recordAttendance(tx");
    expect(pending, "no pending lookup").toBeGreaterThan(-1);
    expect(record, "no record call").toBeGreaterThan(-1);
    expect(pending, "the lookup must come first").toBeLessThan(record);
  });

  it("only while nobody has answered it", () => {
    // Once an administrator has decided, the mark is settled and a new photo is
    // not a correction to it. Without `reviewedAt: null` a rejected mark would
    // be quietly re-openable by the person it was rejected for.
    expect(code(PHONE)).toMatch(/reviewedAt: null/);
  });

  it("and never touches the day", () => {
    // They marked it. The time on the record is the time they marked it, and a
    // retry twenty minutes later must not move it.
    const phone = source(PHONE);
    const start = phone.indexOf("async function reverifyMark");
    expect(start).toBeGreaterThan(-1);
    const body = phone.slice(start, phone.indexOf("\n}\n", start));
    expect(body).not.toMatch(/attendanceDay\.(update|upsert|create)/);
    expect(body).not.toMatch(/recordAttendance/);
  });

  it("clears the doubt when the retry matches", () => {
    const phone = code(PHONE);
    expect(phone).toMatch(/const cleared = face\.outcome === "ACCEPTED"/);
    expect(phone).toMatch(/flaggedForReview: !cleared/);
  });
});

describe("both flagged notifications open the queue", () => {
  it("and not the attendance grid", () => {
    // Half of them said `/attendance`, which is the grid: an administrator
    // following the notification arrived at a screen with no verdict buttons on
    // it and no indication of which row they had been sent to look at.
    for (const file of [PHONE, KIOSK]) {
      const body = code(file);
      const links = body.match(/link: "\/attendance[^"]*"/g) ?? [];
      expect(links.length, file).toBeGreaterThan(0);
      for (const link of links) {
        expect(link, file).toBe('link: "/attendance/review"');
      }
    }
  });
});

describe("the shared device hardens what it means to harden", () => {
  it("names every field it overrides, including the new one", () => {
    /**
     * The kiosk spreads the organisation's policy and then re-hardens fields by
     * name. A key it does not name is inherited -- which has already happened
     * once, when `requireBlink` was inherited and a printed photo passed at
     * reception.
     *
     * `onMismatch` is named here and set to `REVIEW` deliberately: the owner's
     * answer was that a reception queue is a worse failure than a mark somebody
     * has to look at. What matters is that it is a decision in the source and
     * not an accident of the spread.
     */
    const kiosk = code(KIOSK);
    const start = kiosk.indexOf("...rules.faceMatch,");
    expect(start).toBeGreaterThan(-1);
    const block = kiosk.slice(start, kiosk.indexOf("});", start));
    for (const field of ["mode:", "whenNotEnrolled:", "requireBlink:", "rejectMultipleFaces:", "threshold:", "onMismatch:", "retriesBeforeReview:"]) {
      expect(block, field).toContain(field);
    }
  });
});

describe("every field that decides whether somebody goes to work is reachable", () => {
  /**
   * This codebase's recurring failure, and the one the owner named directly:
   * things that are built, tested and then editable nowhere.
   *
   * `requireBlink` and `onMismatch` are the two settings that decide whether a
   * refusal happens at all. Both existed in the schema with no control anywhere
   * in the product, so the only way to change either was the settings API by
   * hand — which is how a blink check that refused sixteen of eighteen marks in
   * one morning stayed switched on. Nobody could see it, so nobody could turn
   * it off.
   */
  const FORM = "src/app/(app)/settings/attendance/AttendanceSettingsForm.tsx";

  it("the blink has a switch", () => {
    expect(code(FORM)).toMatch(/checked=\{faceMatch\.requireBlink\}/);
  });

  it("and so does what happens when a face will not match", () => {
    expect(code(FORM)).toMatch(/faceMatch\.onMismatch === "REVIEW"/);
    expect(code(FORM)).toMatch(/onMismatch: v \? "REVIEW" : "BLOCK"/);
  });

  it("and how many tries come before that review is a box, not a sentence", () => {
    // "after four tries" was written into this form twice and was never what
    // happened. The number is now read from the policy, and the sentences
    // read from the number.
    expect(code(FORM)).toMatch(/value=\{faceMatch\.retriesBeforeReview\}/);
    expect(code(FORM)).not.toMatch(/after four tries/);
  });

  it("the mismatch switch is only offered where it does anything", () => {
    // Under OFF nothing is compared and under ADVISORY nothing is refused, so
    // the choice only means something in REQUIRED. A control that silently does
    // nothing is worse than one that is not there.
    expect(code(FORM)).toMatch(/faceMatch\.mode !== "REQUIRED"/);
  });
});

describe("a check-in leaves the day open", () => {
  /**
   * Measured on one live organisation over a week: every check-in scored
   * HALF_DAY the moment it was made, because the day was evaluated as if the
   * check-out had already failed to come, and the owner corrected those rows
   * by hand each evening. The verdict on a missing check-out belongs to the
   * close of the day.
   */
  const RECORD = "src/services/attendance/record.ts";
  const REVIEW = "src/services/attendance/review.ts";

  it("record.ts evaluates a check-in as open and a check-out as closed", () => {
    expect(code(RECORD)).toMatch(/open: type === "CHECK_IN"/);
  });

  it("and a rejected check-in on an open day becomes an absence", () => {
    // Otherwise the day keeps reading "checked in" with no check-in on it, and
    // the nightly close settles a punch that was taken back.
    const review = code(REVIEW);
    const start = review.indexOf("async function unmarkDay");
    expect(start).toBeGreaterThan(-1);
    const body = review.slice(start, review.indexOf("\n}\n", start));
    expect(body).toMatch(/const workedStatus =[\s\S]{0,160}day\.status === "CHECKED_IN"/);
  });

  it("but on a week off or a holiday it becomes that rest day again, never an absence", () => {
    // Rejecting a flagged check-in on a Sunday while the row was CHECKED_IN
    // wrote ABSENT for the Sunday, and payroll docked a day nobody was
    // expected to work. The day's kind is read the way the mark read it.
    const review = code(REVIEW);
    expect(review).toMatch(/const dayKind = await dayKindFor\(tx, ctx\.organizationId!, event\.employee, dayDate\)/);
    const start = review.indexOf("async function unmarkDay");
    const body = review.slice(start, review.indexOf("\n}\n", start));
    expect(body).toMatch(/dayKind === "WEEK_OFF" \? "WEEK_OFF" : dayKind === "HOLIDAY" \? "HOLIDAY" : "ABSENT"/);
    expect(body).toMatch(/\{ status: withoutArrival, systemStatus: withoutArrival \}/);
  });

  it("and a rejected check-out reopens the day rather than scoring it", () => {
    /**
     * It used to settle the row at once through `missingCheckout` and stamp
     * `overriddenAt`, which froze that verdict: the real check-out that
     * evening was recorded, `recordAttendance` refused to recompute an
     * overridden status, and "you can mark it again" was not true.
     */
    const review = code(REVIEW);
    expect(review).not.toMatch(/settleOpenDay/);
    const start = review.indexOf("async function unmarkDay");
    const body = review.slice(start, review.indexOf("\n}\n", start));
    const reopen = body.slice(body.lastIndexOf("lastCheckOutAt: null"));
    expect(reopen).toMatch(/status: "CHECKED_IN" as const, systemStatus: "CHECKED_IN" as const/);
    expect(reopen).not.toMatch(/overriddenAt/);
    // The check-in branch still records the decision on the row.
    expect(body.match(/overriddenAt: new Date\(\)/g)).toHaveLength(1);
  });
});

describe("a night shift keys to its shift day", () => {
  /**
   * A 22:00-06:00 shift's 06:00 check-out fell on the next date, found no
   * check-in there, and was refused "you have not checked in today" -- every
   * night. `shiftDayFor` resolves the moment to the shift day right after the
   * rules are loaded, and everything that used the wall clock uses that.
   */
  it("phone: resolves the day from the rules before anything reads it", () => {
    const phone = code(PHONE);
    const rules = phone.indexOf("const rules = await getAttendanceRules(ctx, wallClock.date)");
    const resolved = phone.indexOf("const local = shiftDayFor(rules, wallClock)");
    const window = phone.indexOf("isWithinMarkingWindow(rules, local.minutes)");
    expect(rules).toBeGreaterThan(-1);
    expect(resolved).toBeGreaterThan(rules);
    expect(window).toBeGreaterThan(resolved);
    expect(phone).not.toMatch(/const local = instantInZone\(/);
  });

  it("kiosk: the same", () => {
    const kiosk = code(KIOSK);
    const rules = kiosk.indexOf("const rules = await getAttendanceRules(ctx, wallClock.date)");
    const resolved = kiosk.indexOf("const local = shiftDayFor(rules, wallClock)");
    const window = kiosk.indexOf("isWithinMarkingWindow(rules, local.minutes)");
    expect(rules).toBeGreaterThan(-1);
    expect(resolved).toBeGreaterThan(rules);
    expect(window).toBeGreaterThan(resolved);
    expect(kiosk).not.toMatch(/const local = instantInZone\(/);
  });

  it("and the panel is told about the same day", () => {
    // `getTodayStatus` loaded the rules inside the same `Promise.all` as the
    // day row, so the row was always today's calendar date.
    const phone = code(PHONE);
    const start = phone.indexOf("export async function getTodayStatus");
    expect(start).toBeGreaterThan(-1);
    const body = phone.slice(start);
    const rules = body.indexOf("const rules = await getAttendanceRules(ctx, wallClock.date)");
    const resolved = body.indexOf("const local = shiftDayFor(rules, wallClock)");
    const dayStart = body.indexOf("const dayStart = new Date(`${local.date}T00:00:00.000Z`)");
    expect(rules).toBeGreaterThan(-1);
    expect(resolved).toBeGreaterThan(rules);
    expect(dayStart).toBeGreaterThan(resolved);
    expect(body).toMatch(/date: local\.date,/);
    expect(body).toMatch(/nowMinutes: local\.minutes,/);
  });
});

describe("a later check-out is a later departure, not a photo retake", () => {
  /**
   * The re-check branch caught every later check-out on a day whose earlier
   * one was flagged, so "check out again -- the later time counts" was false:
   * somebody who left at lunch under a doubted photo and came back to leave at
   * seven had the seven o'clock treated as a retake and the day scored to
   * lunchtime.
   */
  it("phone: the reverify branch takes a check-out only within the retake window", () => {
    const phone = code(PHONE);
    expect(phone).toMatch(/export const RETAKE_WINDOW_MINUTES = 10;/);
    const retake = phone.indexOf("const isRetake =");
    expect(retake).toBeGreaterThan(-1);
    const expression = phone.slice(retake, phone.indexOf(";", retake));
    expect(expression).toMatch(/input\.type === "CHECK_IN" \|\|/);
    expect(expression).toMatch(/now\.getTime\(\) - pending\.occurredAt\.getTime\(\) <= RETAKE_WINDOW_MINUTES \* 60_000/);
    expect(phone).toMatch(/if \(pending && isRetake && input\.selfie\)/);
  });
});

describe("the panel knows which mark is waiting", () => {
  it("getTodayStatus returns pendingReview, check-in first", () => {
    // So it can offer "Retake photo" for a doubted check-in. A CHECK_IN with a
    // pending CHECK_IN reaches `reverifyMark` before `recordAttendance` would
    // refuse it as a second arrival; the five-minute guard runs only for a
    // CHECK_OUT.
    const phone = code(PHONE);
    const start = phone.indexOf("export async function getTodayStatus");
    const body = phone.slice(start);
    expect(body).toMatch(/findPendingMark\(ctx, ctx\.employeeId, local\.date, "CHECK_IN"\)/);
    expect(body).toMatch(/findPendingMark\(ctx, ctx\.employeeId, local\.date, "CHECK_OUT"\)/);
    expect(body).toMatch(/const pendingReview: "CHECK_IN" \| "CHECK_OUT" \| null = pendingCheckIn\s*\? "CHECK_IN"/);
    expect(body).toMatch(/^\s*pendingReview,$/m);
  });

  it("and the order that makes a check-in retake possible holds", () => {
    const phone = code(PHONE);
    const guard = phone.indexOf("assertCheckoutNotTooSoon(");
    const pending = phone.indexOf("findPendingMark(ctx, employee.id");
    const record = phone.indexOf("recordAttendance(tx");
    // The guard sits under `if (input.type === "CHECK_OUT")` and never
    // intercepts a CHECK_IN.
    const guardBlock = phone.slice(phone.lastIndexOf('if (input.type === "CHECK_OUT")', guard), guard);
    expect(guardBlock).toMatch(/if \(input\.type === "CHECK_OUT"\) \{/);
    expect(pending).toBeGreaterThan(guard);
    expect(record).toBeGreaterThan(pending);
  });
});

describe("a check-out seconds after the check-in is refused", () => {
  /**
   * Three of them in four days on the live instance, 9 to 60 seconds after
   * the check-in, each scoring the day ABSENT with nothing worked. The button
   * had turned into "Check out" and was pressed again.
   */
  const RECORD = "src/services/attendance/record.ts";

  it("record.ts refuses it with a conflict, inside the transaction", () => {
    const record = code(RECORD);
    const start = record.indexOf("export function assertCheckoutNotTooSoon");
    expect(start, "no guard").toBeGreaterThan(-1);
    const body = record.slice(start, record.indexOf("\n}\n", start));
    expect(body).toMatch(/checkoutTooSoon\(/);
    expect(body).toMatch(/throw new ConflictError/);
    expect(body).toMatch(/Check out when you leave\./);
    expect(body).toMatch(/Check out when they leave\./);

    // Asked after "nothing to check out from", before the day is evaluated.
    const nothing = record.indexOf("nothing to check out from");
    const guard = record.indexOf("assertCheckoutNotTooSoon(existingDay");
    const evaluate = record.indexOf("evaluateDay(");
    expect(guard, "no call in recordAttendance").toBeGreaterThan(nothing);
    expect(guard).toBeLessThan(evaluate);
  });

  for (const [name, file] of Object.entries({ phone: PHONE, kiosk: KIOSK })) {
    it(`${name}: asks before the selfie is stored or the engine runs`, () => {
      // A refusal that has already uploaded a photo and spent a PIN is a
      // refusal that cost something.
      const body = code(file);
      const guard = body.indexOf("assertCheckoutNotTooSoon(");
      const engine = body.indexOf("describeSequence(");
      const upload = body.indexOf("storage().put(");
      expect(guard, "no guard").toBeGreaterThan(-1);
      expect(engine, "no engine call").toBeGreaterThan(-1);
      expect(guard, "the guard must come before the engine").toBeLessThan(engine);
      expect(guard, "the guard must come before the upload").toBeLessThan(upload);
    });
  }

  it("kiosk: asks before a PIN is spent", () => {
    const kiosk = code(KIOSK);
    expect(kiosk.indexOf("assertCheckoutNotTooSoon(")).toBeLessThan(kiosk.indexOf("authoriseBypass("));
  });

  it("a later check-out still replaces the earlier one", () => {
    // The honest repair for an early check-out that slipped past the guard.
    expect(code(RECORD)).toMatch(/\{ lastCheckOutAt: now \}/);
    expect(code(RECORD)).toMatch(/Replaces the check-out at/);
  });
});

describe("the fence is the radius, and nothing else unless asked", () => {
  /**
   * The accuracy gate (35 m at a 300 m radius on the live instance) turned
   * away old phones standing at the counter and recorded nothing, so the owner
   * saw blanks. The distance is the fact; the accuracy is recorded beside it.
   */
  const REVIEW = "src/services/attendance/review.ts";
  const ADMIN = "src/services/attendance/admin.ts";

  it("phone: never derives a ceiling from the fence", () => {
    expect(code(PHONE)).not.toMatch(/accuracyBudget/);
  });

  it("phone: the ceiling is the organisation's switch, or none", () => {
    const phone = code(PHONE);
    expect(phone).toMatch(/function accuracyCeiling\([^)]*\): number \| null/);
    expect(phone).toMatch(/rules\.gpsAccuracy\.enforce \? rules\.gpsAccuracy\.maxMeters : null/);
    expect(phone).toMatch(/checkGeofence\(input\.coordinates, fence, \{ maxAccuracyMeters: accuracyCeiling\(rules\) \}\)/);
  });

  it("phone: the panel is told there may be no ceiling", () => {
    expect(code(PHONE)).toMatch(/const maxAccuracyMeters: number \| null = accuracyCeiling\(rules\)/);
  });

  it("and the accuracy travels with every mark instead", () => {
    const phone = code(PHONE);
    // Both writes on the phone path, and the status the panel reads from.
    expect(phone.match(/accuracyMeters: wholeMetres\(input\.coordinates\?\.accuracyMeters\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(phone).toMatch(/accuracyMeters: e\.accuracyMeters/);
    expect(code(REVIEW)).toMatch(/accuracyMeters: event\.accuracyMeters/);
    expect(code(ADMIN)).toMatch(/checkIn: \{ distanceMeters: number \| null; accuracyMeters: number \| null \} \| null/);
    expect(code(ADMIN)).toMatch(/checkOut: \{ distanceMeters: number \| null; accuracyMeters: number \| null \} \| null/);
  });
});

describe("the audit row says how crowded the frame was", () => {
  // Sixteen "several faces" refusals in one week were bystanders behind the
  // counter, and nothing recorded said so.
  for (const [name, file] of Object.entries({ phone: PHONE, kiosk: KIOSK })) {
    it(`${name}: records the face count and the bystanders`, () => {
      const body = code(file);
      expect(body).toMatch(/facesSeen\(candidate\)/);
      expect(body).toMatch(/faceCount: faces\?\.faceCount \?\? null/);
      expect(body).toMatch(/bystanders: faces\?\.bystanders \?\? null/);
    });
  }
});

describe("the escape reaches the service from the phone", () => {
  /**
   * `acceptForReview` was declared in the phone route's zod schema and never
   * read from the form, so it parsed to `false` on every request and "Mark
   * anyway" did nothing. Seven refusals for one person in one morning on the
   * live instance. The kiosk route read its own copy and worked.
   */
  const PHONE_ROUTE = "src/app/api/attendance/mark/route.ts";
  const KIOSK_ROUTE = "src/app/api/kiosk/mark/route.ts";

  it("phone: the field is taken from the form, not left to the schema default", () => {
    expect(code(PHONE_ROUTE)).toMatch(/acceptForReview: form\.get\("acceptForReview"\)/);
  });

  it("kiosk: still reads it", () => {
    expect(code(KIOSK_ROUTE)).toMatch(/form\.get\("acceptForReview"\) === "true"/);
  });
});
