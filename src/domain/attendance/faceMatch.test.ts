import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_MATCH_POLICY,
  LEGACY_FACE_MATCH_POLICY,
  type FaceCandidate,
  type FaceMatchPolicy,
  bestSimilarity,
  checkEnrolmentPhoto,
  cosineSimilarity,
  describeConfidence,
  evaluateFaceMatch,
  reviewAfterAttempts,
  safeParseFaceMatchPolicy,
} from "./faceMatch";

/** A normalised descriptor pointing mostly along one axis. */
function descriptor(seed: number, length = 128): number[] {
  const raw = Array.from({ length }, (_, i) => Math.sin(seed * (i + 1)) + (i === 0 ? seed : 0));
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

const REFERENCE = descriptor(1);
const SAME = REFERENCE.map((v, i) => v * 0.98 + descriptor(1.02)[i]! * 0.02);
const STRANGER = descriptor(7);

/**
 * A good capture: one clear face, and a blink was seen.
 *
 * `blinked: true` is part of the baseline because every other test here is
 * about identity, and a fixture that silently failed liveness would make all of
 * them assert the liveness path by accident.
 */
function candidate(overrides: Partial<FaceCandidate> = {}): FaceCandidate {
  return { descriptor: SAME, faceCount: 1, detectionScore: 0.95, blinked: true, ...overrides };
}

function policyWith(patch: Partial<FaceMatchPolicy>): FaceMatchPolicy {
  return { ...DEFAULT_FACE_MATCH_POLICY, ...patch };
}

describe("face similarity", () => {
  it("scores an identical descriptor at 1", () => {
    expect(cosineSimilarity(REFERENCE, REFERENCE)).toBeCloseTo(1, 6);
  });

  it("scores a near-identical descriptor high", () => {
    expect(cosineSimilarity(REFERENCE, SAME)).toBeGreaterThan(0.9);
  });

  it("scores an unrelated descriptor low", () => {
    expect(cosineSimilarity(REFERENCE, STRANGER)).toBeLessThan(0.363);
  });

  it("refuses to compare descriptors of different lengths", () => {
    expect(cosineSimilarity(REFERENCE, [1, 0, 0])).toBe(-1);
  });

  it("takes the best of several enrolled references", () => {
    expect(bestSimilarity(SAME, [STRANGER, REFERENCE])).toBeGreaterThan(0.9);
    expect(bestSimilarity(STRANGER, [REFERENCE])).toBeLessThan(0.363);
  });

  it("returns -1 when nothing is enrolled", () => {
    expect(bestSimilarity(SAME, [])).toBe(-1);
  });
});

describe("face match verdict", () => {
  it("OFF skips comparison entirely", () => {
    const verdict = evaluateFaceMatch(candidate(), [REFERENCE], policyWith({ mode: "OFF" }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBeNull();
    expect(verdict.flagForReview).toBe(false);
  });

  it("accepts a matching face", () => {
    const verdict = evaluateFaceMatch(candidate(), [REFERENCE], policyWith({ mode: "REQUIRED" }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBe(true);
    expect(verdict.flagForReview).toBe(false);
    expect(verdict.score).toBeGreaterThan(0.363);
  });

  it("REQUIRED sends a stranger to review rather than turning them away", () => {
    /**
     * This asserted `allowed: false`, and the change is deliberate.
     *
     * `REQUIRED` refused everything it doubted, which meant the review queue
     * built for exactly this case received nothing at all from the organisation
     * running it: a refused attempt writes no attendance day, and both queue
     * queries filter on one. The doubt was recorded where nobody would look at
     * it, and the person went home unmarked.
     *
     * A stranger is now marked, flagged, and put in front of an administrator
     * with the selfie and the score. Rejecting it removes the day.
     */
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: STRANGER }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", retriesBeforeReview: 0 }),
    );
    expect(verdict.outcome).toBe("REVIEW");
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe("NO_MATCH");
    expect(verdict.flagForReview).toBe(true);
    // And the number an administrator needs to weigh it, which a refusal used
    // to throw away.
    expect(verdict.score).toBeTypeOf("number");
  });

  it("turns a stranger away first, for as many tries as the organisation set", () => {
    /**
     * The count the settings screen promised and the code never honoured. Under
     * `REVIEW` with a non-zero count the verdict is a refusal that carries the
     * count; the caller turns the last refusal into a flagged mark when the
     * person asks. The score still travels, so the eventual review has it.
     */
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: STRANGER }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", retriesBeforeReview: 3 }),
    );
    expect(verdict.outcome).toBe("REFUSED");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("NO_MATCH");
    expect(verdict.reviewAfterAttempts).toBe(3);
    expect(verdict.flagForReview).toBe(true);
    expect(verdict.score).toBeTypeOf("number");
  });

  it("and blocks them outright when the organisation asks for a closed door", () => {
    // The old behaviour, still available, and now a setting somebody chooses
    // rather than a consequence of `mode` they did not know they were picking.
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: STRANGER }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", onMismatch: "BLOCK" }),
    );
    expect(verdict.outcome).toBe("REFUSED");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("NO_MATCH");
    // No way out is offered, because the policy means it.
    expect(verdict.reviewAfterAttempts).toBeNull();
  });

  // The mode that makes this safe to roll out to a whole company.
  it("ADVISORY records a mismatch but lets the person work", () => {
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: STRANGER }),
      [REFERENCE],
      policyWith({ mode: "ADVISORY" }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBe(false);
    expect(verdict.flagForReview).toBe(true);
  });

  it("refuses a photo with no face", () => {
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: null, faceCount: 0 }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED" }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("NO_FACE_DETECTED");
    expect(verdict.message).toContain("could not see a face");
  });

  it("refuses a photo containing two people", () => {
    // `faceCount: 2` now means two faces of comparable size, both at the
    // camera. A head at the back of the room is a bystander and the engine no
    // longer counts it here, so this case is somebody standing beside the
    // employee, which is what the refusal is for.
    const verdict = evaluateFaceMatch(
      candidate({ faceCount: 2 }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED" }),
    );
    expect(verdict.reason).toBe("MULTIPLE_FACES");
    expect(verdict.allowed).toBe(false);
  });

  it("can be configured to tolerate more than one face", () => {
    const verdict = evaluateFaceMatch(
      candidate({ faceCount: 2 }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", rejectMultipleFaces: false }),
    );
    expect(verdict.matched).toBe(true);
  });

  it("refuses a photo too poor to judge", () => {
    const verdict = evaluateFaceMatch(
      candidate({ detectionScore: 0.4 }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED" }),
    );
    expect(verdict.reason).toBe("LOW_QUALITY");
  });

  it("handles an employee with no reference photo per policy", () => {
    const allowed = evaluateFaceMatch(candidate(), [], policyWith({ whenNotEnrolled: "ALLOW" }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe("NOT_ENROLLED");
    expect(allowed.flagForReview).toBe(true);

    const blocked = evaluateFaceMatch(candidate(), [], policyWith({ whenNotEnrolled: "BLOCK" }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toContain("reference photo");
  });

  // An outage is the system's fault, so it must never cost someone their day's pay.
  it("refuses a broken engine while enforcing rather than waving it through", () => {
    // See "an engine that cannot run" below for why this reversed: allowing it
    // under REQUIRED silently converted the whole fleet to "everybody passes".
    const verdict = evaluateFaceMatch(
      candidate({ engineError: "models missing" }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED" }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("ENGINE_UNAVAILABLE");
    expect(verdict.flagForReview).toBe(true);
  });

  it("respects a raised threshold", () => {
    const strict = evaluateFaceMatch(
      candidate(),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", threshold: 0.999 }),
    );
    expect(strict.matched).toBe(false);
  });

  it("describes confidence coarsely rather than as a raw number", () => {
    expect(describeConfidence(null)).toBe("NONE");
    expect(describeConfidence(0.9)).toBe("STRONG");
    expect(describeConfidence(0.4)).toBe("GOOD");
    expect(describeConfidence(0.1)).toBe("WEAK");
  });
});

describe("enrolment photo checks", () => {
  it("accepts a clear single-face photo", () => {
    expect(checkEnrolmentPhoto(candidate({ detectionScore: 0.95 })).ok).toBe(true);
  });

  // Enrolment is stricter than a daily check-in: a bad reference poisons every
  // future comparison.
  it("is stricter than a check-in about quality", () => {
    const asCheckIn = evaluateFaceMatch(candidate({ detectionScore: 0.8 }), [REFERENCE]);
    expect(asCheckIn.reason).toBeUndefined();

    const asEnrolment = checkEnrolmentPhoto(candidate({ detectionScore: 0.8 }));
    expect(asEnrolment.ok).toBe(false);
    expect(asEnrolment.reason).toBe("LOW_QUALITY");
  });

  it("refuses a group photo", () => {
    const result = checkEnrolmentPhoto(candidate({ faceCount: 3 }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("exactly one face");
  });

  it("refuses a photo with no face", () => {
    expect(checkEnrolmentPhoto(candidate({ descriptor: null, faceCount: 0 })).ok).toBe(false);
  });

  it("refuses when the engine is unavailable rather than enrolling nothing", () => {
    const result = checkEnrolmentPhoto(candidate({ engineError: "no models" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ENGINE_UNAVAILABLE");
  });
});

describe("liveness", () => {
  it("records a still photograph held up to the camera instead of refusing it", () => {
    /**
     * **This is a deliberate loosening, and it is worth being honest about.**
     *
     * A print-out of the right person matches perfectly, so identity alone
     * cannot catch it, and the blink was the only thing that could. It was also
     * measured: on the live instance sixteen of eighteen marks in one morning
     * were refused `NO_BLINK`, and one employee's check-out was refused
     * fourteen times in a row and never went through. A signal that wrong about
     * real people cannot be the thing that decides whether they are paid.
     *
     * So the blink stops being a gate and becomes evidence. The photograph is
     * still caught -- it lands in the review queue with `NO_BLINK` against it,
     * an administrator sees the selfie, and rejecting it now removes the day.
     * What changed is who is inconvenienced while that happens.
     */
    const verdict = evaluateFaceMatch(candidate({ blinked: false }), [REFERENCE]);
    expect(verdict.outcome).toBe("REVIEW");
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("NO_BLINK");
    expect(verdict.flagForReview).toBe(true);
  });

  it("compares the face even when the blink is missing", () => {
    /**
     * The reversal, and the bug it fixes.
     *
     * Liveness used to be judged first and to *return*, so a missing blink
     * meant the descriptor was never compared: every blink refusal on the live
     * instance carried `faceMatchScore: null`, and an administrator opening the
     * queue saw a photograph and no number to weigh it against.
     */
    const verdict = evaluateFaceMatch(
      { descriptor: STRANGER, faceCount: 1, detectionScore: 0.95, blinked: false },
      [REFERENCE],
    );
    expect(verdict.score).toBeTypeOf("number");
    expect(verdict.matched).toBe(false);
    // Both doubts survive to the queue. One `reason` field could only carry the
    // first, so the second was thrown away before anybody saw it.
    expect(verdict.reasons).toContain("NO_MATCH");
    expect(verdict.reasons).toContain("NO_BLINK");
  });

  it("records rather than refuses when nothing could look for a blink", () => {
    // An older client sending one frame, or a landmark model that would not
    // load. Both are ours to fix rather than the employee's fault — but the
    // answer is the PIN, not a day recorded as if a face had been checked.
    // Allowing it here also skipped the identity comparison entirely, because
    // this branch sits above it.
    // The old assertion was `allowed: false` and the answer was a PIN. Both
    // are ours to fix rather than the employee's fault, and the employee is no
    // longer the one who pays for it: the mark stands and somebody confirms it.
    for (const blinked of [null, undefined]) {
      const verdict = evaluateFaceMatch(candidate({ blinked }), [REFERENCE]);
      expect(verdict.outcome).toBe("REVIEW");
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe("BLINK_UNKNOWN");
      expect(verdict.flagForReview).toBe(true);
    }
  });

  it("lets an organisation turn the blink off without turning matching off", () => {
    const verdict = evaluateFaceMatch(
      candidate({ blinked: false }),
      [REFERENCE],
      policyWith({ requireBlink: false }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBe(true);
  });

  it("is skipped entirely when matching is off", () => {
    const verdict = evaluateFaceMatch(
      candidate({ blinked: false }),
      [REFERENCE],
      policyWith({ mode: "OFF" }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });
});

describe("the shipped defaults", () => {
  // These four lines are the difference between a face check and a face
  // *record*. Every one of them was the other way round, and together they
  // meant anybody's face marked anybody's attendance.
  it("refuse rather than observe", () => {
    expect(DEFAULT_FACE_MATCH_POLICY.mode).toBe("REQUIRED");
    expect(DEFAULT_FACE_MATCH_POLICY.whenNotEnrolled).toBe("BLOCK");
    expect(DEFAULT_FACE_MATCH_POLICY.requireBlink).toBe(true);
    expect(DEFAULT_FACE_MATCH_POLICY.rejectMultipleFaces).toBe(true);
  });

  it("give a stranger two more tries out of the box, and then review rather than refuse", () => {
    // The owner's number. A refusal that carries a count is a door that opens
    // on the third try; a refusal that carries `null` is the closed door only
    // `onMismatch: "BLOCK"` may set.
    const verdict = evaluateFaceMatch(candidate({ descriptor: STRANGER }), [REFERENCE]);
    expect(verdict.outcome).toBe("REFUSED");
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe("NO_MATCH");
    expect(verdict.reviewAfterAttempts).toBe(2);
    expect(verdict.flagForReview).toBe(true);
  });

  it("send a mismatch to review rather than block it", () => {
    expect(DEFAULT_FACE_MATCH_POLICY.onMismatch).toBe("REVIEW");
  });

  it("block somebody who has no reference photo, out of the box", () => {
    const verdict = evaluateFaceMatch(candidate(), []);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("NOT_ENROLLED");
  });
});

describe("an engine that cannot run", () => {
  /**
   * It used to be allowed in every mode, and that was the wrong call.
   *
   * The reasoning was sound as far as it went: a missing model file is the
   * system's problem, not the employee's, and an office should not be unable to
   * mark attendance because of it. What it missed is that returning
   * `allowed: true` under REQUIRED turns "only your own face marks your
   * attendance" into "everybody passes" — silently, fleet-wide, kiosk included,
   * with nothing to show for it but a line in a boot log the next deploy throws
   * away.
   *
   * Under REQUIRED it now refuses, and the PIN is the way through: a route a
   * person standing at a gate can actually take, which records the day as
   * unverified instead of pretending it was checked. ADVISORY is unchanged,
   * which is what lets an organisation be moved in two steps rather than one.
   */
  it("refuses while enforcing, and says why", () => {
    const verdict = evaluateFaceMatch(
      candidate({ engineError: "models missing" }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED" }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("ENGINE_UNAVAILABLE");
    expect(verdict.flagForReview).toBe(true);
    // Never claims a match it did not make, in either direction.
    expect(verdict.matched).toBeNull();
    expect(verdict.score).toBeNull();
  });

  it("still records rather than blocks while advisory", () => {
    const verdict = evaluateFaceMatch(
      candidate({ engineError: "models missing" }),
      [REFERENCE],
      policyWith({ mode: "ADVISORY" }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("ENGINE_UNAVAILABLE");
    expect(verdict.flagForReview).toBe(true);
  });
});

describe("one frame is not a way past the check", () => {
  /**
   * The hole that mattered most, and the reason it was invisible.
   *
   * `blinked === null` means nothing could assess a blink — which is exactly
   * what a client sending a single frame produces. That branch returned
   * `allowed: true` unconditionally, and it sat *above* the identity
   * comparison, so the descriptor was never compared at all. One frame,
   * anybody's face, and the day was written as an ordinary present day. The
   * kiosk was not protected either: it forces `mode` and `whenNotEnrolled` and
   * inherits `requireBlink` from the organisation.
   */
  it("still flags an unassessable blink while enforcing, even with a perfect match", () => {
    // It no longer refuses -- see the liveness block for why -- but a single
    // frame must never be quietly as good as a sequence. The doubt is recorded
    // and somebody looks at it.
    const verdict = evaluateFaceMatch(
      candidate({ blinked: null, descriptor: REFERENCE }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", requireBlink: true }),
    );
    expect(verdict.outcome).toBe("REVIEW");
    expect(verdict.reason).toBe("BLINK_UNKNOWN");
    expect(verdict.flagForReview).toBe(true);
  });

  it("reports the match it did make", () => {
    // The old branch returned before `bestSimilarity` ran, so a refusal here
    // must not claim a score either — saying "no match" would be as wrong as
    // saying "matched".
    /**
     * The exact reversal of the old assertion, and the reason for it.
     *
     * This required `score: null`, because the branch returned before
     * `bestSimilarity` ran and claiming a number it had not computed would have
     * been a lie. It computes it now. An administrator judging a one-frame
     * capture needs to know whether the face was the right one: "no blink, and
     * a 0.81 match to her enrolled photo" is a decision, and "no blink" alone
     * is a shrug.
     */
    const verdict = evaluateFaceMatch(
      candidate({ blinked: undefined, descriptor: REFERENCE }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", requireBlink: true }),
    );
    expect(verdict.matched).toBe(true);
    expect(verdict.score).toBeTypeOf("number");
  });

  it("is distinct from somebody who simply did not blink", () => {
    // Different failures, different fixes: one is answered by holding still,
    // the other by blinking. They used to share a reason code.
    const unknown = evaluateFaceMatch(
      candidate({ blinked: null }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", requireBlink: true }),
    );
    const refused = evaluateFaceMatch(
      candidate({ blinked: false }),
      [REFERENCE],
      policyWith({ mode: "REQUIRED", requireBlink: true }),
    );
    expect(unknown.reason).toBe("BLINK_UNKNOWN");
    expect(refused.reason).toBe("NO_BLINK");
  });

  it("still only records it while advisory", () => {
    const verdict = evaluateFaceMatch(
      candidate({ blinked: null }),
      [REFERENCE],
      policyWith({ mode: "ADVISORY", requireBlink: true }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.flagForReview).toBe(true);
  });
});

describe("the policy an organisation had before this block existed", () => {
  /**
   * Why this is not just a duplicate of the defaults test above.
   *
   * No stored attendance policy carries a `faceMatch` key -- the block was
   * added after they were written, and `DEFAULT_ATTENDANCE_POLICY` does not
   * include it -- so making the shipped default strict would have applied it to
   * every existing organisation on the deploy that shipped it, and refused
   * attendance to everybody who has not enrolled a face. `getAttendanceRules`
   * reads an absent block as this policy instead.
   */
  it("keeps the old behaviour, so nobody is locked out by a deploy", () => {
    expect(LEGACY_FACE_MATCH_POLICY.mode).toBe("ADVISORY");
    expect(LEGACY_FACE_MATCH_POLICY.whenNotEnrolled).toBe("ALLOW");
    expect(LEGACY_FACE_MATCH_POLICY.requireBlink).toBe(false);
  });

  it("lets somebody with no reference photo mark attendance", () => {
    const verdict = evaluateFaceMatch(candidate(), [], LEGACY_FACE_MATCH_POLICY);
    expect(verdict.allowed).toBe(true);
  });

  it("lets somebody through who did not blink, because nothing asked them to", () => {
    const verdict = evaluateFaceMatch(candidate({ blinked: false }), [REFERENCE], LEGACY_FACE_MATCH_POLICY);
    expect(verdict.allowed).toBe(true);
  });

  it("still records a mismatch rather than ignoring it", () => {
    // Permissive is not the same as blind: the flag is what an administrator
    // sees, and it is what makes ADVISORY worth anything at all.
    const verdict = evaluateFaceMatch(
      candidate({ descriptor: STRANGER }),
      [REFERENCE],
      LEGACY_FACE_MATCH_POLICY,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.matched).toBe(false);
    expect(verdict.flagForReview).toBe(true);
  });

  it("differs from the shipped default in exactly the three ways that block somebody", () => {
    const differences = (Object.keys(DEFAULT_FACE_MATCH_POLICY) as (keyof typeof DEFAULT_FACE_MATCH_POLICY)[])
      .filter((key) => DEFAULT_FACE_MATCH_POLICY[key] !== LEGACY_FACE_MATCH_POLICY[key])
      .sort();
    expect(differences).toEqual(["mode", "requireBlink", "whenNotEnrolled"]);
  });
});

/**
 * How many times somebody is turned away before they are let through.
 *
 * "face match na ho to review me ... kitna retry dena hai ye setting me rahe",
 * and two for a photo that is simply unusable. The numbers are not arbitrary
 * and they are not the same, because the failures are not the same:
 * moving somewhere brighter genuinely fixes a dark frame, and no number of
 * attempts creates a reference photo that HR has not uploaded.
 */
describe("how long somebody keeps trying before they may mark anyway", () => {
  const policy = DEFAULT_FACE_MATCH_POLICY;

  it("never counts a blink, because a blink never refuses", () => {
    expect(reviewAfterAttempts("NO_BLINK", policy)).toBeNull();
    expect(reviewAfterAttempts("BLINK_UNKNOWN", policy)).toBeNull();
  });

  it("offers the way out at once when trying again cannot help", () => {
    // No reference photo, or no working model. Asking somebody to stand in a
    // corridor and press a button four more times would be a lie about what
    // the button does.
    expect(reviewAfterAttempts("NOT_ENROLLED", policy)).toBe(0);
    expect(reviewAfterAttempts("ENGINE_UNAVAILABLE", policy)).toBe(0);
  });

  it("gives a bad photo two more goes", () => {
    for (const reason of ["NO_FACE_DETECTED", "MULTIPLE_FACES", "LOW_QUALITY"] as const) {
      expect(reviewAfterAttempts(reason, policy), reason).toBe(2);
    }
  });

  it("gives a face that will not match whatever the organisation set", () => {
    expect(reviewAfterAttempts("NO_MATCH", policy)).toBe(2);
    expect(reviewAfterAttempts("NO_MATCH", { ...policy, retriesBeforeReview: 5 })).toBe(5);
    expect(reviewAfterAttempts("NO_MATCH", { ...policy, retriesBeforeReview: 0 })).toBe(0);
  });

  it("and the count is a real setting, not a number in this file", () => {
    // It was `4`, written here, and it never ran: the mismatch branch went to
    // review before the count was consulted. The setting is what makes the
    // number true.
    expect(DEFAULT_FACE_MATCH_POLICY.retriesBeforeReview).toBe(2);
    const parsed = safeParseFaceMatchPolicy({ retriesBeforeReview: 11 });
    expect(parsed.success).toBe(false);
    const fraction = safeParseFaceMatchPolicy({ retriesBeforeReview: 1.5 });
    expect(fraction.success).toBe(false);
  });

  it("offers nothing at all when the organisation wants a closed door", () => {
    // `onMismatch: "BLOCK"` has to mean it. A way out that appears on the fifth
    // attempt would make the setting decorative.
    expect(reviewAfterAttempts("NO_MATCH", { ...policy, onMismatch: "BLOCK" })).toBeNull();
  });
});

/**
 * The stored policy that must keep parsing.
 *
 * **This is the one that locks people out.** `getAttendanceRules` does not
 * throw when a stored `faceMatch` block fails to parse -- it logs and
 * substitutes `DEFAULT_FACE_MATCH_POLICY`, which carries `whenNotEnrolled:
 * "BLOCK"`. So a schema change that rejects a payload written last week does
 * not fail a build or a test; it silently hands an organisation a locked door
 * on the morning of the deploy, for every employee HR has not enrolled.
 *
 * This is the payload live in production, copied exactly. It predates
 * `onMismatch` and it carries `requireBlink` as a boolean, which is why that
 * field is still typed as one.
 */
describe("a policy written before this round still parses", () => {
  const STORED_IN_PRODUCTION = {
    mode: "REQUIRED",
    threshold: 0.363,
    requireBlink: true,
    whenNotEnrolled: "BLOCK",
    minDetectionScore: 0.7,
    rejectMultipleFaces: true,
  };

  it("parses, rather than falling back to the shipped defaults", () => {
    const parsed = safeParseFaceMatchPolicy(STORED_IN_PRODUCTION);
    expect(parsed.success).toBe(true);
  });

  it("keeps every value that organisation chose", () => {
    const parsed = safeParseFaceMatchPolicy(STORED_IN_PRODUCTION);
    expect(parsed.success && parsed.data.threshold).toBe(0.363);
    expect(parsed.success && parsed.data.mode).toBe("REQUIRED");
    expect(parsed.success && parsed.data.requireBlink).toBe(true);
  });

  it("and reaches the new key at its default rather than at nothing", () => {
    // zod strips what it does not declare and defaults what it does. A key that
    // arrived as `undefined` here would make the whole feature inert with no
    // error anywhere.
    const parsed = safeParseFaceMatchPolicy(STORED_IN_PRODUCTION);
    expect(parsed.success && parsed.data.onMismatch).toBe("REVIEW");
    expect(parsed.success && parsed.data.retriesBeforeReview).toBe(2);
  });

  it("an organisation with no faceMatch block at all is unaffected", () => {
    // Two of the three live organisations are in this state, and the legacy
    // block is what keeps them working. It inherits new keys from the strict
    // default, so this asserts the inherited value is the permissive one.
    expect(LEGACY_FACE_MATCH_POLICY.mode).toBe("ADVISORY");
    expect(LEGACY_FACE_MATCH_POLICY.whenNotEnrolled).toBe("ALLOW");
    expect(LEGACY_FACE_MATCH_POLICY.onMismatch).toBe("REVIEW");
    expect(LEGACY_FACE_MATCH_POLICY.retriesBeforeReview).toBe(2);
  });
});
