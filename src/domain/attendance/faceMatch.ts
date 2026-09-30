/**
 * Face-match decisions.
 *
 * Pure: takes descriptors and a policy, returns a verdict. The models that
 * *produce* descriptors live in `lib/face`; nothing about ONNX, image decoding
 * or file storage reaches this module, so every rule below is unit-testable.
 *
 * Two principles shape this:
 *
 *   1. **The server decides.** A browser can be made to say anything, so the
 *      client uploads pixels and nothing else. It never sends a descriptor and
 *      never sends a verdict.
 *   2. **A failed match is not automatically fraud.** Bad light, a mask, a new
 *      beard and a cheap front camera all lower the score. `ADVISORY` mode
 *      records the doubt and lets the person work; only `REQUIRED` blocks.
 */

import { z } from "zod";

/** Face descriptors are L2-normalised, so cosine similarity is a dot product. */
export type FaceDescriptor = number[];

export type FaceMatchMode =
  /** Selfie is stored, no comparison is attempted. */
  | "OFF"
  /** Compared and recorded; a mismatch is flagged for review but does not block. */
  | "ADVISORY"
  /** A mismatch refuses the check-in. */
  | "REQUIRED";

export interface FaceMatchPolicy {
  mode: FaceMatchMode;
  /**
   * Cosine similarity above which two faces are considered the same person.
   * SFace's published operating point is 0.363; raising it trades false
   * accepts for false rejects.
   */
  threshold: number;
  /** Detector confidence below which the photo is rejected as unusable. */
  minDetectionScore: number;
  /** What to do when the employee has no reference photo enrolled yet. */
  whenNotEnrolled: "ALLOW" | "BLOCK";
  /**
   * A second face as close to the camera as the employee is refused -- it
   * invites buddy-punching. A head at the back of the frame is not a second
   * face: `faceCount` no longer counts it (see `FaceCandidate`).
   */
  rejectMultipleFaces: boolean;
  /**
   * Require a blink before the photo counts.
   *
   * Matching alone cannot tell a person from a photograph of that person, and
   * both capture paths took a single still frame — so a printed photo held up
   * to the camera passed every check this product had, `REQUIRED` included. A
   * blink is the cheapest liveness signal that needs no extra hardware: the eye
   * has to close and reopen across the captured sequence.
   *
   * **What this no longer does is refuse.** It was a gate, and the gate was
   * measured: of eighteen marks on the live instance in one morning, sixteen
   * were refused `NO_BLINK`, and one employee lost her check-out entirely
   * across fourteen consecutive attempts. Every one of those refusals carried
   * `faceMatchScore: null`, because liveness was checked *before* identity and
   * returned first, so the product refused people without ever looking at their
   * face. A signal this noisy cannot be the thing that decides whether somebody
   * is paid.
   *
   * So: on means ask for it, measure it, and send a mark without one to review.
   * Off means do not ask and do not judge. Neither value blocks anybody.
   */
  requireBlink: boolean;

  /**
   * What a confirmed non-match does once the retries are spent.
   *
   * `REVIEW` records the mark, flags it, and lets an administrator decide from
   * the selfie, which is what the review queue was built for and, under
   * `REQUIRED`, never received. `BLOCK` is the old behaviour and stays
   * available for an organisation that wants a closed door.
   *
   * Deliberately separate from `mode`. `mode` decides six things at once; this
   * is one question with one answer, and it is the answer that decides whether
   * somebody standing at the door goes to work.
   */
  onMismatch: "BLOCK" | "REVIEW";
  /**
   * How many refused attempts a face that will not match gets before the mark
   * is taken and sent to review. Zero means the first mismatch is recorded and
   * reviewed at once; the person is never turned away.
   *
   * Only meaningful under `onMismatch: "REVIEW"`. Under `BLOCK` there is no
   * review to go to, so there is nothing to count down to.
   *
   * **This number was four, and it never ran.** The mismatch branch returned
   * `review()` straight away under `REVIEW`, so the "four tries" the code and
   * the settings copy promised was dead: every organisation was living on
   * zero. The owner's answer, asked directly, was two -- one bad angle
   * forgiven, and then somebody looks.
   */
  retriesBeforeReview: number;
}

/**
 * The shipped policy, and why it now refuses rather than observes.
 *
 * This defaulted to `ADVISORY` with `whenNotEnrolled: "ALLOW"`, which together
 * meant a *confirmed* non-match still wrote the attendance, and somebody with
 * no reference photo at all was waved through. On a live payroll that is not
 * "recording the doubt" — it is a face check that never refuses anybody, while
 * the record it produces says the face was checked.
 *
 * `ADVISORY` stays available, and is still the right setting for the first
 * fortnight while an organisation enrols everybody. It is no longer what an
 * organisation gets without choosing it.
 */
export const DEFAULT_FACE_MATCH_POLICY: FaceMatchPolicy = {
  mode: "REQUIRED",
  threshold: 0.363,
  minDetectionScore: 0.7,
  whenNotEnrolled: "BLOCK",
  rejectMultipleFaces: true,
  requireBlink: true,
  onMismatch: "REVIEW",
  retriesBeforeReview: 2,
};

/**
 * What an organisation whose policy predates this block gets.
 *
 * **This exists so that tightening the default does not lock anybody out.**
 * Stored attendance policies carry no `faceMatch` key at all -- the block was
 * added after they were written -- so making the shipped default strict would
 * have applied it to every existing organisation the moment it deployed, and
 * refused attendance to every employee who has not enrolled a face. On a live
 * payroll that is a Monday morning with a queue at the door.
 *
 * So an absent block means "carry on as before", and an organisation moves to
 * the strict default deliberately: from the settings screen, or with
 * `npm run fence:default`, which will not switch it on while anybody is
 * unenrolled and names who they are.
 */
export const LEGACY_FACE_MATCH_POLICY: FaceMatchPolicy = {
  ...DEFAULT_FACE_MATCH_POLICY,
  mode: "ADVISORY",
  whenNotEnrolled: "ALLOW",
  requireBlink: false,
};

/**
 * How many refusals a person sees before they may mark anyway and be reviewed.
 *
 * Not every failure is worth retrying, and the difference matters to somebody
 * standing in a corridor. A dark or crowded frame is worth two more tries:
 * moving somewhere brighter genuinely fixes it. A face that will not match is
 * worth whatever the organisation set in `retriesBeforeReview`, because light
 * and angle move the score and a later attempt often lands -- and because how
 * long to keep somebody at the door is the owner's call, not this file's. A
 * missing reference photo or a dead model file is worth none at all, because
 * retrying cannot create the thing that is missing, so the way out is offered
 * at once.
 *
 * `null` means the person is never refused for that reason, so there is nothing
 * to count.
 */
export function reviewAfterAttempts(
  reason: FaceRejectReason,
  policy: FaceMatchPolicy,
): number | null {
  switch (reason) {
    // Liveness never refuses. It records a doubt and moves on.
    case "NO_BLINK":
    case "BLINK_UNKNOWN":
      return null;
    // Nothing the person can do differently.
    case "ENGINE_UNAVAILABLE":
    case "NOT_ENROLLED":
      return 0;
    case "NO_FACE_DETECTED":
    case "MULTIPLE_FACES":
    case "LOW_QUALITY":
      return 2;
    case "NO_MATCH":
      return policy.onMismatch === "REVIEW" ? policy.retriesBeforeReview : null;
  }
}

/**
 * The stored shape of the `faceMatch` key inside an ATTENDANCE policy payload.
 *
 * Every field defaults, so a policy row written before face matching existed
 * still parses — which is most of them.
 *
 * The threshold range is deliberately narrow. SFace's published operating point
 * is 0.363; below about 0.2 the model accepts nearly anybody, and above about
 * 0.6 it rejects the same person on a different day. Neither end is a setting
 * somebody should be able to reach from a form by holding down a key.
 */
export const faceMatchPolicySchema = z.object({
  mode: z.enum(["OFF", "ADVISORY", "REQUIRED"]).default(DEFAULT_FACE_MATCH_POLICY.mode),
  threshold: z.number().min(0.2).max(0.6).default(DEFAULT_FACE_MATCH_POLICY.threshold),
  minDetectionScore: z
    .number()
    .min(0.3)
    .max(0.99)
    .default(DEFAULT_FACE_MATCH_POLICY.minDetectionScore),
  whenNotEnrolled: z.enum(["ALLOW", "BLOCK"]).default(DEFAULT_FACE_MATCH_POLICY.whenNotEnrolled),
  rejectMultipleFaces: z.boolean().default(DEFAULT_FACE_MATCH_POLICY.rejectMultipleFaces),
  /**
   * Still a boolean, deliberately.
   *
   * Its *meaning* narrowed, from ask-and-refuse to ask-and-flag, but its type
   * did not, because one organisation has `requireBlink: true` written into
   * stored JSON. A parse failure here is not an error any caller sees:
   * `getAttendanceRules` logs it and substitutes the strict shipped default,
   * which would hand that organisation `whenNotEnrolled: "BLOCK"` on deploy.
   * Widening this to a three-state enum would have done exactly that.
   */
  requireBlink: z.boolean().default(DEFAULT_FACE_MATCH_POLICY.requireBlink),
  onMismatch: z.enum(["BLOCK", "REVIEW"]).default(DEFAULT_FACE_MATCH_POLICY.onMismatch),
  // Ten is not a limit anybody should reach; it is there so a typo cannot keep
  // somebody at the door for a hundred attempts.
  retriesBeforeReview: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(DEFAULT_FACE_MATCH_POLICY.retriesBeforeReview),
});

export function safeParseFaceMatchPolicy(input: unknown) {
  return faceMatchPolicySchema.safeParse(input);
}

export type FaceRejectReason =
  | "NO_FACE_DETECTED"
  | "MULTIPLE_FACES"
  | "LOW_QUALITY"
  | "NOT_ENROLLED"
  | "NO_MATCH"
  | "NO_BLINK"
  | "ENGINE_UNAVAILABLE"
  | "BLINK_UNKNOWN";

export interface FaceCandidate {
  /** Descriptor extracted from the primary face of the submitted selfie, if one was found. */
  descriptor: FaceDescriptor | null;
  /**
   * Faces of comparable size to the primary, including it; background heads
   * are not counted.
   *
   * This was every detection, and on a shop floor with people behind the
   * employee it refused sixteen marks in a week as "several faces". The
   * primary is the largest face in the frame, and a face counts alongside it
   * only at half its box area or more (`domain/attendance/primaryFace`). Zero
   * still means nobody was found; two still means somebody else is at the
   * camera.
   */
  faceCount: number;
  /** Faces the engine saw and ignored as background. Informational; never refuses. */
  bystanderCount?: number;
  /** Detector confidence for the primary face. */
  detectionScore: number;
  /**
   * Whether a blink was seen across the captured sequence.
   *
   * `true` seen, `false` looked and did not see one, **`null` not assessed** —
   * an older client that sent a single frame, or a landmark model that would
   * not load. Null is treated as the system's problem rather than the
   * employee's, which is the line the rest of this module already draws.
   */
  blinked?: boolean | null;
  /** Set when the engine could not run at all (missing models, decode failure). */
  engineError?: string | null;
}

/**
 * What the product does with one submitted photo.
 *
 * Three outcomes, not two, and the third is the point of this round. A mark can
 * now be *taken and doubted* rather than only taken or refused, which is what
 * makes a review queue worth having: until now `REQUIRED` refused everything it
 * doubted, so the queue an administrator was given to work through received
 * nothing at all from the organisation that needed it most.
 */
export type FaceOutcome =
  /** Verified. Nothing to look at. */
  | "ACCEPTED"
  /** Recorded, and an administrator has to decide from the selfie. */
  | "REVIEW"
  /** Not recorded. The person tries again, or marks anyway and is reviewed. */
  | "REFUSED";

export interface FaceMatchVerdict {
  outcome: FaceOutcome;
  /** Whether the mark may be written. `outcome !== "REFUSED"`. */
  allowed: boolean;
  /** Whether the face actually matched. Null when no comparison happened. */
  matched: boolean | null;
  /** Best cosine similarity against the enrolled references, if compared. */
  score: number | null;
  /** The doubt that decided the outcome. */
  reason?: FaceRejectReason;
  /**
   * Every doubt, not only the deciding one.
   *
   * A mark can fail two ways at once, and it usually does: no blink *and* a
   * weak score. The old shape carried one `reason`, so the second was thrown
   * away before it reached the administrator who had to judge it.
   */
  reasons: FaceRejectReason[];
  /** Shown to the employee. Never blames them for something the system did. */
  message?: string;
  /** True when an admin should look at this event. */
  flagForReview: boolean;
  mode: FaceMatchMode;
  /**
   * After how many refusals the person may mark anyway and be reviewed.
   *
   * `null` on an accepted or already-reviewed mark, and on a refusal there is
   * no way out of. See `reviewAfterAttempts`.
   */
  reviewAfterAttempts: number | null;
}

/** Cosine similarity of two L2-normalised descriptors. */
export function cosineSimilarity(a: FaceDescriptor, b: FaceDescriptor): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  // Guard against un-normalised input sneaking in.
  return Math.max(-1, Math.min(1, sum));
}

/** Best similarity against any enrolled reference. */
export function bestSimilarity(
  candidate: FaceDescriptor,
  references: readonly FaceDescriptor[],
): number {
  let best = -1;
  for (const reference of references) {
    const score = cosineSimilarity(candidate, reference);
    if (score > best) best = score;
  }
  return best;
}

const MESSAGES: Record<FaceRejectReason, string> = {
  NO_FACE_DETECTED:
    "We could not see a face in that photo. Hold the camera at eye level in good light and try again.",
  // "Take the picture on your own" was the old line, and it was wrong advice
  // once the count stopped including the back of the room: the only way to
  // earn this refusal now is another face as large as yours.
  MULTIPLE_FACES:
    "Somebody else is as close to the camera as you are. Step apart and try again.",
  LOW_QUALITY:
    "That photo was too blurry or dark to check. Move somewhere brighter and try again.",
  NOT_ENROLLED:
    "You do not have a reference photo on file yet. Ask HR to add one to your profile.",
  NO_MATCH:
    "That photo does not match the reference on your profile. Try again in better light, or ask HR if your photo needs updating.",
  NO_BLINK:
    "We need to see you blink. Look at the camera and blink once while it is recording.",
  ENGINE_UNAVAILABLE:
    "Face verification is temporarily unavailable. Your selfie has been recorded for review.",
  // Distinct from the engine being down, because the fix is different: this one
  // is answered by holding still for the whole capture, not by an administrator.
  BLINK_UNKNOWN:
    "We could not tell whether you blinked. Hold the phone steady and look at it for the whole count.",
};

/**
 * What the employee is told when a doubt is recorded rather than refused.
 *
 * The refusal wording above tells somebody how to try again, which is wrong
 * once the mark has gone through: they are done, and what they need to know is
 * that it counted and that somebody will look at it.
 */
const REVIEW_MESSAGES: Partial<Record<FaceRejectReason, string>> = {
  NO_BLINK: "Marked. We did not see you blink, so an administrator will confirm it.",
  BLINK_UNKNOWN: "Marked. We could not check the blink, so an administrator will confirm it.",
  NO_MATCH: "Marked. The photo did not match your profile, so an administrator will confirm it.",
  NOT_ENROLLED: "Marked. You have no reference photo yet, so an administrator will confirm it.",
  ENGINE_UNAVAILABLE:
    "Marked. Face verification is unavailable, so an administrator will confirm it.",
  NO_FACE_DETECTED: "Marked. We could not see a face, so an administrator will confirm it.",
  MULTIPLE_FACES:
    "Marked. Somebody else was as close to the camera as you, so an administrator will confirm it.",
  LOW_QUALITY: "Marked. The photo was too dark to check, so an administrator will confirm it.",
};

/**
 * Decides what happens to one submitted photo.
 *
 * **Read the order.** Liveness used to be judged first and to return, so a
 * missing blink meant the face was never compared at all -- every blink refusal
 * on the live instance carried `faceMatchScore: null`, and an administrator
 * opening the queue saw a selfie and no number to weigh it against. Identity is
 * now always established when there is a face to establish it from, and the
 * blink is a doubt carried alongside it rather than a gate in front of it.
 *
 * **And read what refuses.** Only three things do: a photo with nothing usable
 * in it, a face that will not match under `onMismatch: "BLOCK"`, and somebody
 * with no reference photo under `whenNotEnrolled: "BLOCK"`. Everything else is
 * taken and flagged. A refusal is no longer the end of the road either -- see
 * `reviewAfterAttempts` -- because the alternative, measured, was an employee
 * losing a day's check-out across fourteen attempts.
 */
export function evaluateFaceMatch(
  candidate: FaceCandidate,
  references: readonly FaceDescriptor[],
  policy: FaceMatchPolicy = DEFAULT_FACE_MATCH_POLICY,
): FaceMatchVerdict {
  const base = { mode: policy.mode, score: null, matched: null } as const;

  if (policy.mode === "OFF") {
    return { ...base, outcome: "ACCEPTED", allowed: true, flagForReview: false, reasons: [], reviewAfterAttempts: null };
  }

  const enforcing = policy.mode === "REQUIRED";

  /** A doubt that is recorded rather than acted on. */
  const review = (reason: FaceRejectReason, extra: Partial<FaceMatchVerdict> = {}): FaceMatchVerdict => ({
    ...base,
    ...extra,
    outcome: "REVIEW",
    allowed: true,
    reason,
    reasons: [reason],
    message: REVIEW_MESSAGES[reason] ?? MESSAGES[reason],
    flagForReview: true,
    reviewAfterAttempts: null,
  });

  /** A doubt that stops the mark. Under ADVISORY nothing stops it. */
  const refuse = (reason: FaceRejectReason, extra: Partial<FaceMatchVerdict> = {}): FaceMatchVerdict =>
    enforcing
      ? {
          ...base,
          ...extra,
          outcome: "REFUSED",
          allowed: false,
          reason,
          reasons: [reason],
          message: MESSAGES[reason],
          flagForReview: true,
          reviewAfterAttempts: reviewAfterAttempts(reason, policy),
        }
      : review(reason, extra);

  /**
   * The engine itself failed.
   *
   * A broken model file is the system's problem, not the employee's, and it is
   * not something a fourth attempt fixes. Under `REQUIRED` the face path is
   * refused with the way out offered immediately; `/api/health?deep=1` reports
   * the engine's state so an operator finds out without being told.
   */
  if (candidate.engineError) return refuse("ENGINE_UNAVAILABLE");

  if (candidate.faceCount === 0 || !candidate.descriptor) {
    return refuse("NO_FACE_DETECTED", { matched: false });
  }

  if (policy.rejectMultipleFaces && candidate.faceCount > 1) {
    return refuse("MULTIPLE_FACES", { matched: false });
  }

  if (candidate.detectionScore < policy.minDetectionScore) {
    return refuse("LOW_QUALITY", { matched: false });
  }

  if (references.length === 0) {
    // Somebody should enrol them, whichever way the policy falls.
    return policy.whenNotEnrolled === "ALLOW"
      ? { ...base, outcome: "REVIEW", allowed: true, reason: "NOT_ENROLLED", reasons: ["NOT_ENROLLED"], flagForReview: true, reviewAfterAttempts: null }
      : refuse("NOT_ENROLLED");
  }

  /**
   * Identity, always. This is the line the round turned on.
   */
  const score = bestSimilarity(candidate.descriptor, references);
  const matched = score >= policy.threshold;

  /**
   * Liveness, alongside.
   *
   * `false` means the lids did not move across the capture; `null` or absent
   * means nothing could assess it -- an older client sending one frame, or a
   * crop too dark to read. They are different words on screen and the same
   * outcome here, because neither is the employee's fault and neither is proof
   * of anything.
   */
  const livenessDoubt: FaceRejectReason | null = !policy.requireBlink
    ? null
    : candidate.blinked === true
      ? null
      : candidate.blinked === false
        ? "NO_BLINK"
        : "BLINK_UNKNOWN";

  if (!matched) {
    const reasons: FaceRejectReason[] = livenessDoubt ? ["NO_MATCH", livenessDoubt] : ["NO_MATCH"];
    /**
     * Under `REVIEW`, the organisation's count decides: zero takes the mark now
     * and flags it; anything else turns the person away and tells them how many
     * tries they have, and the caller turns the last refusal into a flagged mark
     * when they ask (`acceptForReview`). Under `BLOCK` a refusal is a refusal.
     *
     * This branch used to return `review()` for every `REVIEW` policy, which
     * made the retry count unreachable and the settings copy that named it
     * untrue.
     */
    const takeNow = policy.onMismatch === "REVIEW" && policy.retriesBeforeReview === 0;
    return takeNow
      ? { ...review("NO_MATCH", { matched, score }), reasons }
      : { ...refuse("NO_MATCH", { matched, score }), reasons };
  }

  if (livenessDoubt) {
    // Matched, and we could not see the lids move. Recorded, and looked at --
    // never refused, because refusing this is what cost somebody a day.
    return { ...review(livenessDoubt, { matched, score }), matched, score };
  }

  return {
    mode: policy.mode,
    outcome: "ACCEPTED",
    allowed: true,
    matched: true,
    score,
    reasons: [],
    flagForReview: false,
    reviewAfterAttempts: null,
  };
}

/**
 * How confident the match is, for display. Deliberately coarse — showing an
 * employee "0.4127" invites arguments about a number nobody can act on.
 */
export function describeConfidence(
  score: number | null,
  policy: FaceMatchPolicy = DEFAULT_FACE_MATCH_POLICY,
): "STRONG" | "GOOD" | "WEAK" | "NONE" {
  if (score == null) return "NONE";
  if (score >= policy.threshold + 0.2) return "STRONG";
  if (score >= policy.threshold) return "GOOD";
  return "WEAK";
}

/**
 * Whether a reference photo is good enough to enrol.
 *
 * Enrolment is stricter than a daily check-in: a poor reference photo poisons
 * every future comparison, so it is worth refusing at the point of upload
 * rather than generating months of mysterious mismatches.
 *
 * The face count here is the same `faceCount` a check-in gets: faces of
 * comparable size to the primary, background heads not counted. So a portrait
 * with somebody small in the background enrols, and the descriptor stored is
 * the largest face's. "Exactly one face" in the copy means one face at the
 * camera.
 */
export interface EnrolmentCheck {
  ok: boolean;
  reason?: FaceRejectReason;
  message?: string;
}

export function checkEnrolmentPhoto(
  candidate: FaceCandidate,
  minDetectionScore = 0.85,
): EnrolmentCheck {
  if (candidate.engineError) {
    return {
      ok: false,
      reason: "ENGINE_UNAVAILABLE",
      message: "Face verification is unavailable, so this photo cannot be enrolled yet.",
    };
  }
  if (candidate.faceCount === 0 || !candidate.descriptor) {
    return { ok: false, reason: "NO_FACE_DETECTED", message: MESSAGES.NO_FACE_DETECTED };
  }
  if (candidate.faceCount > 1) {
    return {
      ok: false,
      reason: "MULTIPLE_FACES",
      message: "The reference photo must contain exactly one face.",
    };
  }
  if (candidate.detectionScore < minDetectionScore) {
    return {
      ok: false,
      reason: "LOW_QUALITY",
      message:
        "That photo is not clear enough to use as a reference. Use a well-lit, front-facing photo.",
    };
  }
  return { ok: true };
}
