"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  LogIn,
  LogOut,
  MapPin,
  MapPinOff,
  RefreshCw,
  ScanFace,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RequestFailed, api } from "@/lib/client/api";
import { formatDuration, formatTime } from "@/lib/utils";
// The same maths the server decides with, so the screen cannot promise one
// answer and the mark be refused for another.
import { useFrameHint } from "@/components/attendance/useFrameHint";
import {
  BLINK_LEAD_MS,
  BURST_FRAMES,
  BURST_GAP_MS,
  blinkWindowSeconds,
} from "@/domain/attendance/capture";
import { checkGeofence, describeDistance } from "@/domain/attendance/geo";
import {
  MIN_MINUTES_BEFORE_CHECKOUT,
  STATUS_LABELS,
  type AttendanceStatus,
} from "@/domain/attendance/policy";
import { toast } from "@/components/ui/toast";

/**
 * Check in and out.
 *
 * The screen an employee uses most, usually one-handed on a phone in a corridor,
 * so it is a single large button with everything it needs gathered before the
 * press: location fix, camera stream, and whether their face is enrolled.
 *
 * Every way this can fail — GPS off, permission refused, no camera, weak fix,
 * face not recognised — gets its own message saying what to actually do. A bare
 * "failed" here costs somebody a day's pay.
 */

export interface TodayStatus {
  date: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  status: string;
  workedMinutes: number;
  lateMinutes: number;
  shift: { start: string; end: string; breakMinutes: number };
  requireGps: boolean;
  requireSelfie: boolean;
  faceMatchMode: "OFF" | "ADVISORY" | "REQUIRED";
  faceEnrolled: boolean;
  /** Whether this person may mark from this device at all. */
  canMarkHere: boolean;
  /** Whether the organisation has an office device as the alternative. */
  kioskAvailable: boolean;
  location: { name: string; latitude: number; longitude: number; radiusMeters: number } | null;
  /**
   * The widest accuracy circle the server will accept, or `null` when it does
   * not look at the accuracy at all.
   *
   * Carried rather than re-derived here, so the panel and the server cannot
   * disagree about a reading. `null` is the shipped answer now: the gate was a
   * constant (35 m at a 300 m radius) and it turned away people standing at
   * the counter with a phone too old to do better than ±50 m, recording
   * nothing. The distance decides; the accuracy is stored beside every mark
   * and shown back, so a rough reading is visible rather than refused.
   */
  maxAccuracyMeters: number | null;
  /** When attendance may be marked at all, as clock strings. */
  markingWindow: { opens: string; closes: string };
  /** True when the employee has no branch, so nothing is measured at all. */
  noWorkLocation: boolean;
  /**
   * Today's marks, oldest first, with what was measured for each.
   *
   * The card shows the last one back to the person: the distance the server
   * recorded and how rough the phone's reading was. That is the evidence a
   * reviewer sees, and the employee should see the same thing.
   */
  events: { type: string; distanceMeters: number | null; accuracyMeters: number | null }[];
  /**
   * Which of today's marks is still waiting for a reviewer, if any.
   *
   * The in-review card used to say "press the same button again with a
   * clearer photo", and after a check-in the only button is Check out. This
   * is what lets the panel offer a retake of the right mark instead.
   * Optional because the server grew it after the panel did.
   */
  pendingReview?: "CHECK_IN" | "CHECK_OUT" | null;
}

type GeoState =
  | { kind: "idle" }
  | { kind: "locating" }
  /** `at` is when this reading was taken, and it is why the watch exists. */
  | { kind: "ready"; coords: GeolocationCoordinates; at: number }
  | { kind: "denied" }
  | { kind: "unavailable"; message: string };

/**
 * How often a fresh reading is asked for, and how old one may be at the moment
 * of marking.
 *
 * A watch already reports as the device moves, but some browsers only fire on
 * movement -- so standing still could leave a reading from minutes ago on
 * screen looking current. The interval tops the watch up, and the age limit
 * means a stale one can never be submitted whatever happened in between.
 */
/**
 * Two seconds was too eager, and actively harmful.
 *
 * `getCurrentPosition` on Android answers immediately from the fused provider —
 * Wi-Fi and cell, tens to hundreds of metres out — and only later, if at all,
 * from satellites. Re-asking every two seconds and storing whatever came back
 * meant each fast coarse answer overwrote a slow accurate one, so the longer
 * the panel stayed open the worse the reading got. Six seconds, and `acceptFix`
 * now keeps the better of the two.
 */
const REFRESH_MS = 6_000;
const MAX_FIX_AGE_MS = 15_000;


const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 20_000,
  maximumAge: 0,
};

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "denied" }
  | { kind: "unavailable"; message: string };

export function CheckInPanel({ initial }: { initial: TodayStatus }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState(initial);
  const [geo, setGeo] = useState<GeoState>({ kind: "idle" });
  const [camera, setCamera] = useState<CameraState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action: "CHECK_IN" | "CHECK_OUT" = status.checkedInAt ? "CHECK_OUT" : "CHECK_IN";
  /**
   * Checked out already. It changes the copy and nothing else.
   *
   * This used to be `finished`, and it hid the button. Measured on a live
   * organisation: three check-outs 9-60 s after the check-in, each scoring
   * the day ABSENT with nothing worked, and once the button was gone there
   * was no way to check out again when the person actually left. The server
   * now refuses a check-out under five minutes and takes the later of two, so
   * the button stays.
   */
  const checkedOut = Boolean(status.checkedInAt && status.checkedOutAt);
  const openDay = status.checkedInAt !== null && status.checkedOutAt === null;

  // ---------------------------------------------------------------- location

  const watchRef = useRef<number | null>(null);
  const topUpRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The newest reading, readable from `submit` without waiting for a render. */
  const fixRef = useRef<{ coords: GeolocationCoordinates; at: number } | null>(null);

  /**
   * Keep the better reading, not the newer one.
   *
   * A satellite lock takes seconds and is worth metres; the fused provider
   * answers instantly and is worth hundreds. Storing whatever arrived last threw
   * away the good one every time the top-up fired. A newer reading wins only
   * when it is at least as accurate, or when the one being held has gone stale
   * and is no longer evidence of anything.
   */
  const acceptFix = useCallback((position: GeolocationPosition) => {
    const fix = { coords: position.coords, at: Date.now() };
    const held = fixRef.current;
    if (held) {
      const heldAccuracy = held.coords.accuracy ?? Number.POSITIVE_INFINITY;
      const nextAccuracy = fix.coords.accuracy ?? Number.POSITIVE_INFINITY;
      const heldIsFresh = fix.at - held.at < MAX_FIX_AGE_MS;
      if (heldIsFresh && nextAccuracy > heldAccuracy) return;
    }
    fixRef.current = fix;
    setGeo({ kind: "ready", ...fix });
  }, []);

  const describeGeoError = useCallback((err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) return { kind: "denied" } as const;
    if (err.code === err.TIMEOUT) {
      return { kind: "unavailable", message: "Getting a location fix took too long." } as const;
    }
    return { kind: "unavailable", message: "Your location could not be determined." } as const;
  }, []);

  const stopWatching = useCallback(() => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (topUpRef.current !== null) {
      clearInterval(topUpRef.current);
      topUpRef.current = null;
    }
  }, []);

  /**
   * Start following the device, rather than taking one reading and keeping it.
   *
   * The old version called `getCurrentPosition` once, on a button of its own,
   * and held the answer in state until the mark was submitted. Nothing expired
   * it and nothing re-read it -- so pressing "Get my location" at your desk and
   * "Check in" twenty minutes later from the street submitted the desk. The
   * server then honestly reported four metres.
   */
  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeo({ kind: "unavailable", message: "This device cannot report its location." });
      return;
    }
    stopWatching();
    setGeo({ kind: "locating" });

    watchRef.current = navigator.geolocation.watchPosition(
      acceptFix,
      (err) => {
        // A watch that has already produced a reading may still report a
        // transient failure; that must not wipe a good fix off the screen.
        if (fixRef.current && err.code !== err.PERMISSION_DENIED) return;
        stopWatching();
        setGeo(describeGeoError(err));
      },
      GEO_OPTIONS,
    );

    topUpRef.current = setInterval(() => {
      const age = fixRef.current ? Date.now() - fixRef.current.at : Infinity;
      if (age < REFRESH_MS) return;
      navigator.geolocation.getCurrentPosition(acceptFix, () => undefined, GEO_OPTIONS);
    }, REFRESH_MS);
  }, [acceptFix, describeGeoError, stopWatching]);

  /**
   * A reading taken now, for the moment of submitting.
   *
   * Resolves with the newest one if it is younger than the refresh interval,
   * and otherwise waits for a new one. Never falls back to a stale fix: the
   * caller refuses instead.
   */
  const freshFix = useCallback((): Promise<GeolocationCoordinates | null> => {
    const current = fixRef.current;
    if (current && Date.now() - current.at < REFRESH_MS) return Promise.resolve(current.coords);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          acceptFix(position);
          resolve(position.coords);
        },
        () => resolve(null),
        GEO_OPTIONS,
      );
    });
  }, [acceptFix]);

  // ---------------------------------------------------------------- camera

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera({ kind: "unavailable", message: "This browser cannot use the camera." });
      return;
    }
    setCamera({ kind: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCamera({ kind: "ready" });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") setCamera({ kind: "denied" });
      else if (name === "NotFoundError") {
        setCamera({ kind: "unavailable", message: "No camera was found on this device." });
      } else {
        setCamera({ kind: "unavailable", message: "The camera could not be started." });
      }
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /**
   * Nothing is requested on arrival — deliberately.
   *
   * This used to ask for the camera *and* a location fix from a mount effect,
   * which is two permission prompts at once and neither of them attached to a
   * tap. Chrome on Android will not queue two prompts, and a gesture-less
   * request inside an installed PWA is refused outright with "This site can't
   * ask for your permission" — which is what employees were seeing instead of
   * being able to mark attendance at all.
   *
   * So the big button below is staged: camera, then location, then mark. Each
   * stage is its own press, so every prompt has a fresh user gesture behind it
   * and only ever one is outstanding.
   */
  useEffect(() => stopCamera, [stopCamera]);
  useEffect(() => stopWatching, [stopWatching]);

  /**
   * One tick a second, so "updated 3 s ago" is true and a reading that has gone
   * stale stops the button rather than sitting there looking fresh.
   *
   * `now` starts null and is only ever set on the client: "you checked in 4
   * min ago" is rendered from it, and a clock read during server rendering
   * would disagree with the one read at hydration.
   */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (geo.kind !== "ready" && !openDay) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [geo.kind, openDay]);

  /**
   * A short burst, and what the screen is saying while it happens.
   *
   * `idle` before anything, then the two prompts, then the server's answer.
   * The *decision* is deliberately not made here -- a browser can be made to
   * say anything, so the frames go up and the verdict comes back -- but the
   * employee should not have to submit and wait to find out, so each stage is
   * named on screen as it happens.
   */
  const [faceStage, setFaceStage] = useState<
    "idle" | "look" | "blink" | "checking" | "matched" | "failed"
  >("idle");
  const [faceMessage, setFaceMessage] = useState<string | null>(null);
  /** Set to the server's reason while the retry-or-PIN dialog is open. */
  const [faceFailure, setFaceFailure] = useState<string | null>(null);
  /**
   * How many times in a row the face check has refused this mark.
   *
   * Counted on the client because it is a client concern: the server refuses
   * each attempt on its own merits and has no memory of the last one. What the
   * count decides is only when to *offer* the way out; the server still
   * decides whether that way out exists at all.
   */
  const [faceAttempts, setFaceAttempts] = useState(0);
  /** After how many refusals "Mark anyway" appears. `null` = never, for this reason. */
  const [reviewAfter, setReviewAfter] = useState<number | null>(null);
  /** Who can issue a PIN here, fetched only once somebody asks for one. */
  const [pinHelp, setPinHelp] = useState<
    { name: string; designation: string | null }[] | null
  >(null);
  const [showPinHelp, setShowPinHelp] = useState(false);

  /**
   * Advice drawn from the picture itself, not a fixed caption.
   *
   * The sampling lives in `useFrameHint` now rather than here, because the
   * reception screen needs exactly the same thing and had none of it — its
   * only live guidance was a hardcoded "Blink now", so somebody standing at a
   * dim desk learned the light was the problem only after submitting.
   */
  const frameHint = useFrameHint(videoRef, camera.kind === "ready");

  /** Grabs a frame as a JPEG. Mirrored preview, un-mirrored capture. */
  async function captureSelfie(): Promise<Blob | null> {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;

    const size = Math.min(video.videoWidth, video.videoHeight) || 640;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(
      video,
      (video.videoWidth - size) / 2,
      (video.videoHeight - size) / 2,
      size,
      size,
      0,
      0,
      size,
      size,
    );

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
  }

  /**
   * One still, then the instruction, then the frames the blink has to land in.
   *
   * The old note here said the prompt was "deliberately late" so the capture
   * would not catch the frame before the eyelid moved. The reasoning was sound
   * and the number was not: two frames of a 180 ms burst is 360 ms, which is
   * less time than it takes to read the words. The whole capture finished
   * first. Timings now live in `domain/attendance/capture.ts`, next to the
   * measurement that found this.
   */
  async function captureBurst(): Promise<{ frames: Blob[]; still: Blob } | null> {
    const frames: Blob[] = [];

    /**
     * One frame with their eyes open, before anything is asked of them.
     *
     * It is the photo an administrator sees on the review screen, and it has to
     * be somebody looking at the camera rather than somebody mid-blink.
     */
    setFaceStage("look");
    const still = await captureSelfie();
    if (still) frames.push(still);

    /**
     * Then the instruction, and *then* the recording.
     *
     * This is the fix. The prompt used to appear at the third frame of a
     * 1.4-second capture — about 360 ms in — and sixteen of eighteen marks in
     * one morning were refused for not blinking. Nobody was missing the blink;
     * nobody had blinked yet. The lead-in buys the reading, and the window that
     * follows holds the blink.
     */
    setFaceStage("blink");
    await new Promise((r) => setTimeout(r, BLINK_LEAD_MS));

    for (let i = frames.length; i < BURST_FRAMES; i++) {
      const frame = await captureSelfie();
      if (frame) frames.push(frame);
      if (i < BURST_FRAMES - 1) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    }

    if (frames.length === 0) return null;
    return { frames, still: frames[0] as Blob };
  }

  /**
   * Whether trying again has stopped being the useful thing to offer.
   *
   * `reviewAfter` is the server's answer for this particular reason -- a dark
   * frame is worth two more goes, a face that will not match is worth whatever
   * the organisation set, a missing reference photo is worth none -- and `null`
   * means the policy leaves no way through at all, so the button must not
   * appear.
   */
  const canMarkAnyway = reviewAfter !== null && faceAttempts >= reviewAfter;

  // ---------------------------------------------------------------- submit

  /**
   * The mark the refused attempt was for, so the dialog retries the same one.
   *
   * A retake of a flagged check-in is a CHECK_IN sent while the big button
   * says Check out. If its refusal were retried as `action`, "Retry" would
   * send a check-out instead -- and either be refused for being too soon or,
   * later in the day, actually check the person out.
   */
  const [failedType, setFailedType] = useState<"CHECK_IN" | "CHECK_OUT">("CHECK_IN");
  /** Which of the two buttons is spinning: a retake, or the mark itself. */
  const [retaking, setRetaking] = useState(false);
  /**
   * The dialog is about a retake, not a new mark. "Mark anyway" is hidden
   * then: the mark already exists, and accepting it for review again only
   * uploads a photo to land in the same queue.
   */
  const retakeFailed = failedType === "CHECK_IN" && status.checkedInAt !== null;

  /**
   * `type` defaults to whatever the big button does next. A retake of a
   * flagged check-in passes CHECK_IN explicitly: the server sees a check-in
   * that is already waiting and re-checks it instead of refusing a second one.
   */
  async function submit(acceptForReview = false, type: "CHECK_IN" | "CHECK_OUT" = action) {
    setError(null);
    setBusy(true);
    // A CHECK_IN sent while already checked in is only ever a retake.
    setRetaking(type === "CHECK_IN" && status.checkedInAt !== null);

    try {
      const form = new FormData();
      form.set("type", type);

      /**
       * Read the position again, here, at the moment of marking.
       *
       * Whatever is on screen may be seconds or minutes old depending on how
       * long somebody left the panel open, and the coordinates that go on the
       * record have to be the ones from when the button was pressed. A reading
       * that cannot be refreshed stops the mark rather than sending the old
       * one.
       */
      if (status.requireGps || geo.kind === "ready") {
        const coords = await freshFix();
        if (!coords && status.requireGps) {
          setError(
            "Your location could not be refreshed just now. Move somewhere with a clearer view of the sky and try again.",
          );
          return;
        }
        if (coords) {
          form.set("latitude", String(coords.latitude));
          form.set("longitude", String(coords.longitude));
          if (coords.accuracy != null) {
            form.set("accuracyMeters", String(Math.round(coords.accuracy)));
          }
        }
      }

      if (status.requireSelfie) {
        const burst = await captureBurst();
        if (!burst) {
          setFaceStage("idle");
          setError("The camera did not produce a photo. Try restarting it.");
          return;
        }
        form.set("selfie", burst.still, "selfie.jpg");
        // The whole burst goes up for the blink check; only the still is kept.
        burst.frames.forEach((frame, i) => form.append("frames", frame, `frame-${i}.jpg`));
        setFaceStage("checking");
      }

      if (acceptForReview) form.set("acceptForReview", "true");

      form.set(
        "deviceInfo",
        JSON.stringify({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          screen: `${window.screen.width}x${window.screen.height}`,
        }),
      );

      const response = await fetch("/api/attendance/mark", { method: "POST", body: form });
      const payload = await response.json();

      if (!response.ok) {
        throw new RequestFailed(payload.error, response.status);
      }

      // A run of refusals is over. The next one starts from zero, or somebody
      // who failed twice on Monday is offered the escape on their first try on
      // Tuesday.
      setFaceAttempts(0);
      setReviewAfter(null);

      // On screen, not only in a toast: this is the answer the employee came
      // for, and a toast is gone before somebody standing at a gate has read it.
      if (payload.face?.checked) {
        setFaceStage(payload.face.matched ? "matched" : "idle");
        setFaceMessage(payload.face.matched ? null : (payload.face.message ?? null));
      } else {
        setFaceStage("idle");
        setFaceMessage(payload.face?.message ?? null);
      }

      toast.success(
        payload.reverified === "cleared"
          ? "Your attendance is confirmed"
          : payload.reverified === "pending"
            ? "Still waiting to be confirmed"
            : type === "CHECK_IN"
              ? `Checked in at ${formatTime(payload.occurredAt)}`
              : `Checked out at ${formatTime(payload.occurredAt)}`,
        {
          description:
            payload.face?.checked && payload.face?.matched
              ? "Face verified against your reference photo."
              : payload.face?.message,
        },
      );

      // The camera is left running: the button is still there after a
      // check-out, and stopping the stream here meant the next press had to
      // ask for the camera all over again.
      const refreshed = await api<TodayStatus>("/api/attendance/today");
      setStatus(refreshed);
      router.refresh();
    } catch (err) {
      /**
       * A face refusal is not an error message, it is a fork.
       *
       * Everything else here is "something went wrong, read this". A face that
       * will not match has two real ways forward -- try again, or get a PIN
       * from somebody who can issue one -- and putting them in a dialog is the
       * difference between an employee marking their attendance and an
       * employee standing in a corridor re-reading a sentence.
       */
      const details =
        err instanceof RequestFailed
          ? (err.error.details as
              | { face?: string; reviewAfterAttempts?: number | null }
              | undefined)
          : undefined;
      const faceReason = details?.face;

      if (faceReason) {
        setFaceStage("failed");
        setFaceMessage(err instanceof RequestFailed ? err.error.message : null);
        setFaceFailure(faceReason);
        setFailedType(type);
        setFaceAttempts((n) => n + 1);
        setReviewAfter(details?.reviewAfterAttempts ?? null);
      } else {
        setFaceStage("idle");
        setError(
          err instanceof RequestFailed
            ? err.error.message
            : "We could not reach the server. Check your connection and try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- gating

  /**
   * Where they are, and whether the server will take it.
   *
   * `checkGeofence` is the same function the server decides with, given the
   * same accuracy limit the server uses -- `null` for nearly everybody now, so
   * the distance alone decides and the two sides cannot disagree. The reading's
   * accuracy is still printed beside the distance: a coarse fix from Wi-Fi is
   * an honest measurement of a position that may be wrong, and the person
   * looking at the number should know how rough it is. An organisation that
   * has switched the gate on gets the old behaviour, refusal included.
   */
  const fixAgeMs = geo.kind === "ready" ? Date.now() - geo.at : null;
  const fixStale = fixAgeMs !== null && fixAgeMs > MAX_FIX_AGE_MS;

  const fence =
    geo.kind === "ready" && status.location
      ? checkGeofence(
          {
            latitude: geo.coords.latitude,
            longitude: geo.coords.longitude,
            accuracyMeters: geo.coords.accuracy ?? null,
          },
          {
            latitude: status.location.latitude,
            longitude: status.location.longitude,
            radiusMeters: status.location.radiusMeters,
          },
          { maxAccuracyMeters: status.maxAccuracyMeters },
        )
      : null;

  /** Only ever true when the organisation enforces a limit; `null` never refuses. */
  const accuracyTooLow = fence?.reason === "ACCURACY_TOO_LOW";
  /** Not shown while a refused reading is the reason there is no distance. */
  const distance = fence && !accuracyTooLow ? fence.distanceMeters : null;
  /**
   * A real distance, not a refused reading. This used to be `!fence.ok`, so
   * an accuracy refusal read as "You are outside the branch" to somebody
   * standing inside it.
   */
  const outsideFence = fence?.reason === "OUTSIDE_RADIUS";
  const fenceRefused = fence !== null && !fence.ok;
  /**
   * A reading wider than the fence itself. Not a refusal -- the server takes
   * it and records it -- but a distance measured from a point that rough may
   * be wrong in either direction, and the person should hear that before
   * they walk further in.
   */
  const roughReading =
    geo.kind === "ready" &&
    status.location !== null &&
    !accuracyTooLow &&
    geo.coords.accuracy != null &&
    geo.coords.accuracy > status.location.radiusMeters;

  const geoBlocked =
    status.requireGps &&
    // No branch means nothing is measured, and the server refuses. Offering the
    // button here promised something that could not happen.
    (status.noWorkLocation || geo.kind !== "ready" || fixStale || fenceRefused);
  const cameraBlocked = status.requireSelfie && camera.kind !== "ready";
  /** Permissions granted and nothing in flight: any mark may be attempted. */
  const ready = !busy && !geoBlocked && !cameraBlocked;

  /** Minutes since the check-in, for the open-day card. Client clock only. */
  const minutesSinceCheckIn =
    openDay && now !== null && status.checkedInAt
      ? Math.max(0, Math.floor((now - new Date(status.checkedInAt).getTime()) / 60_000))
      : null;

  /**
   * The server refuses a check-out under `MIN_MINUTES_BEFORE_CHECKOUT`, and it
   * used to be the only thing that did: for those five minutes the button was
   * live and ran the whole blink burst and upload for a refusal that was
   * certain. The same arithmetic here, from the client clock, so the button
   * waits instead. The server's answer still counts; this only spares the
   * upload. `now` is null until the first tick, and the gate stays open until
   * then rather than guess.
   */
  const checkoutTooSoon =
    openDay && minutesSinceCheckIn !== null && minutesSinceCheckIn < MIN_MINUTES_BEFORE_CHECKOUT;
  const checkoutOpensAt = status.checkedInAt
    ? formatTime(
        new Date(new Date(status.checkedInAt).getTime() + MIN_MINUTES_BEFORE_CHECKOUT * 60_000),
      )
    : null;
  const canSubmit = ready && !checkoutTooSoon;

  /**
   * A check-in that is waiting for a reviewer can be re-checked from a clearer
   * photo, and the in-review card says so -- but after a check-in the only
   * button here was Check out. This is the button that card is pointing at.
   * Needs a selfie: a retake without a photo has nothing to re-check and the
   * server would refuse it as a second check-in.
   */
  const canRetake =
    status.pendingReview === "CHECK_IN" && status.checkedOutAt === null && status.requireSelfie;

  /** The newest mark and what the server measured for it. */
  const lastMark = status.events[status.events.length - 1] ?? null;
  const lastMarkDistance = lastMark?.distanceMeters ?? null;
  const lastMarkAccuracy = lastMark?.accuracyMeters ?? null;

  /**
   * What the one big button does next.
   *
   * Asking for both permissions at once is what broke this screen, so they are
   * asked for one press at a time and only while nothing has been tried yet —
   * a refusal or a failure is handled by the panel it belongs to, which
   * explains what went wrong rather than silently re-prompting.
   */
  const prepareStep: "camera" | "location" | null =
    status.requireSelfie && camera.kind === "idle"
      ? "camera"
      : status.requireGps && geo.kind === "idle"
        ? "location"
        : null;

  // The organisation records attendance somewhere else. Say so, rather than
  // showing a camera and a button that will come back 403 — the refusal itself
  // lives in `markAttendance`; this is only the explanation.
  if (!status.canMarkHere) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">
            Shift {status.shift.start} to {status.shift.end}
          </p>
          <p className="mt-0.5 text-2xl font-semibold">
            {status.checkedInAt ? formatTime(status.checkedInAt) : "Not checked in"}
            {status.checkedOutAt ? ` to ${formatTime(status.checkedOutAt)}` : ""}
          </p>
        </div>

        <Alert tone="info" title="Attendance is recorded on the office device">
          {status.kioskAvailable
            ? "Your organisation marks attendance on the shared screen in the office. Tap your name there and your face is checked against the photo on your profile."
            : "Your organisation does not record attendance from personal devices. Ask an administrator how yours should be marked."}
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---------- today ---------- */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              Shift {status.shift.start} – {status.shift.end}
            </p>
            {/* Said before it is needed. The window has always been enforced and
                never shown, so the only way to learn it was to be refused by
                it — at the one moment somebody is standing at a gate. */}
            <p className="text-xs text-muted-foreground">
              Marking open {status.markingWindow.opens} – {status.markingWindow.closes}
            </p>
            {/* Three states, each named. A bare "10:10" used to sit here with
                a "half day" badge beside it from the moment somebody arrived
                -- the day was scored as if the check-out had already failed to
                come. The card now says what has happened and what is next. */}
            <p className="mt-0.5 text-2xl font-semibold">
              {checkedOut ? (
                `Checked out at ${formatTime(status.checkedOutAt)}`
              ) : status.checkedInAt ? (
                <span className="inline-flex items-center gap-1.5">
                  Checked in at {formatTime(status.checkedInAt)}
                  <CheckCircle2 className="size-5 shrink-0 text-success-text" aria-hidden />
                </span>
              ) : (
                "Not checked in"
              )}
            </p>
            {checkedOut ? (
              <>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatDuration(status.workedMinutes)} recorded
                  {status.lateMinutes > 0 ? ` · ${status.lateMinutes} min late` : ""}
                </p>
                {/* The way back from a check-out pressed by mistake. The server
                    keeps the later of two, so saying so is the whole fix. */}
                <p className="mt-1 text-xs text-muted-foreground">
                  Checked out too early by mistake? Check out again when you actually leave
                  &mdash; the later time counts.
                </p>
              </>
            ) : status.checkedInAt ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Check out when you leave
                {/* "0 min ago" is a figure for something that is not a
                    figure yet; the server says "less than a minute ago". */}
                {minutesSinceCheckIn !== null
                  ? minutesSinceCheckIn === 0
                    ? " · You checked in just now"
                    : ` · You checked in ${minutesSinceCheckIn} min ago`
                  : ""}
                {status.lateMinutes > 0 ? ` · ${status.lateMinutes} min late` : ""}
              </p>
            ) : null}
            {/* What the server recorded for the last mark. The reviewer sees
                this pair; the person who made the mark should see it too. */}
            {status.checkedInAt && (lastMarkDistance !== null || lastMarkAccuracy !== null) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Recorded
                {lastMarkDistance !== null
                  ? ` ${describeDistance(lastMarkDistance)} from ${status.location?.name ?? "the branch"}`
                  : ""}
                {lastMarkAccuracy !== null
                  ? `${lastMarkDistance !== null ? "," : ""} GPS ±${lastMarkAccuracy} m`
                  : ""}
              </p>
            ) : null}
          </div>
          <Badge tone={checkedOut ? "success" : status.checkedInAt ? "info" : "neutral"}>
            {STATUS_LABELS[status.status as AttendanceStatus] ?? status.status}
          </Badge>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/* ---------- face enrolment warning ---------- */}
      {status.requireSelfie && status.faceMatchMode !== "OFF" && !status.faceEnrolled ? (
        <Alert tone="warning" title="No reference photo on file">
          {status.faceMatchMode === "REQUIRED"
            ? "Face verification is required here, so you need a reference photo before you can mark attendance. Ask HR to add one."
            : "Your selfies cannot be verified until HR adds a reference photo to your profile."}
        </Alert>
      ) : null}

      {/* Nothing here is hidden after a check-out. The "you are done for
          today" card that used to replace all of this left somebody who had
          pressed Check out by mistake with no way to check out again. */}
      {/* ---------- camera ---------- */}
      {status.requireSelfie ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="relative aspect-square w-full bg-muted">
            <video
              ref={videoRef}
              playsInline
              muted
              // Mirrored so it behaves like a mirror; the capture is not.
              className="size-full scale-x-[-1] object-cover"
            />

            {camera.kind !== "ready" ? (
              <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center">
                {camera.kind === "starting" ? (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> Starting the camera…
                  </span>
                ) : camera.kind === "denied" ? (
                  <div className="space-y-2">
                    <CameraOff className="mx-auto size-7 text-muted-foreground" aria-hidden />
                    <p className="text-sm font-medium">Camera permission was refused</p>
                    <p className="text-xs text-muted-foreground">
                      Allow camera access for this site in your browser settings, then try
                      again. If your phone said it could not ask, another app is drawing over
                      the screen &mdash; a screen dimmer, a blue-light filter or a chat bubble.
                      Close it and try again.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => void startCamera()}>
                      <RefreshCw className="size-4" aria-hidden />
                      Try again
                    </Button>
                  </div>
                ) : camera.kind === "unavailable" ? (
                  <div className="space-y-2">
                    <CameraOff className="mx-auto size-7 text-muted-foreground" aria-hidden />
                    <p className="text-sm">{camera.message}</p>
                    <p className="text-xs text-muted-foreground">
                      Ask your manager to record today&apos;s attendance for you.
                    </p>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => void startCamera()}>
                    <Camera className="size-4" aria-hidden />
                    Turn on the camera
                  </Button>
                )}
              </div>
            ) : (
              /**
               * One strip that keeps talking, rather than one caption that
               * never changes. It is the only thing on this screen that
               * tells somebody what is happening to them while the camera
               * is running, and it is where the verdict lands.
               */
              <div className="pointer-events-none absolute inset-0 flex items-end justify-center p-3">
                <span
                  className={`rounded-full px-3 py-1.5 text-xs font-medium text-white ${
                    faceStage === "matched"
                      ? "bg-success"
                      : faceStage === "failed"
                        ? "bg-danger"
                        : faceStage === "blink"
                          ? "bg-primary"
                          : "bg-black/70"
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  {faceStage === "look"
                    ? "Hold still…"
                    : faceStage === "blink"
                      ? `Blink now · ${blinkWindowSeconds()}s`
                      : faceStage === "checking"
                        ? "Checking your face…"
                        : faceStage === "matched"
                          ? "Face matched"
                          : faceStage === "failed"
                            ? "Face not matched"
                            : (frameHint ?? "Look straight at the camera")}
                </span>
              </div>
            )}
          </div>

          {/* The verdict again, in the flow of the page: the pill sits over
              a moving picture, and this is the sentence somebody reads when
              they are trying to work out what to do next. */}
          {faceStage === "matched" || faceStage === "failed" || faceMessage ? (
            <p
              className={`flex items-start gap-1.5 border-t border-border px-3 py-2 text-xs ${
                faceStage === "failed" ? "text-danger-text" : "text-success-text"
              }`}
              role="status"
              aria-live="polite"
            >
              {faceStage === "failed" ? (
                <CameraOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
              <span>{faceMessage ?? "Your face matched the reference photo on your profile."}</span>
            </p>
          ) : null}

          {status.faceMatchMode !== "OFF" && status.faceEnrolled ? (
            <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <ScanFace className="size-3.5 shrink-0" aria-hidden />
              Your photo is checked against your reference photo on the server.
              {status.faceMatchMode === "ADVISORY"
                ? " A poor match is flagged for HR rather than blocking you."
                : " A photo that does not match will be refused."}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---------- location ---------- */}
      {status.noWorkLocation ? (
        <Alert tone="danger" title="You are not on a branch">
          Attendance is measured against the branch you work from, and you are not on one —
          so there is nothing to check your location against. Ask an administrator to put you
          on a branch under Employees.
        </Alert>
      ) : null}
      {status.requireGps && !status.noWorkLocation ? (
        <div className="rounded-lg border border-border bg-card p-3">
          {geo.kind === "ready" ? (
            <div className="space-y-1">
              {/* Two numbers, labelled, and never the same shape.
                  They used to sit stacked and unlabelled — "65 m from Head
                  Office" above "Accurate to about ±65 m" — which is how a
                  report of "it said 65 m" could not be answered without
                  asking which line was read. */}
              <p className="flex items-center gap-2 text-sm">
                {fenceRefused ? (
                  <MapPinOff className="size-4 shrink-0 text-danger-text" aria-hidden />
                ) : (
                  <MapPin className="size-4 shrink-0 text-success-text" aria-hidden />
                )}
                <span>
                  {distance !== null && status.location ? (
                    <>
                      Distance to {status.location.name}:{" "}
                      <span className="font-medium tabular">
                        {describeDistance(distance)}
                      </span>
                    </>
                  ) : accuracyTooLow ? (
                    // Deliberately no number: the organisation has asked
                    // for a reading this coarse to be refused, so a
                    // distance measured from it would be a promise.
                    "Waiting for a better reading before measuring"
                  ) : (
                    "Location found"
                  )}
                </span>
              </p>
              {/* The limit is only quoted when there is one. It used to
                  read "needs ±35 m or better" for everybody, and nothing
                  needs that any more unless the organisation says so. */}
              <p className="pl-6 text-xs text-muted-foreground">
                {geo.coords.accuracy
                  ? `GPS ±${Math.round(geo.coords.accuracy)} m${
                      status.maxAccuracyMeters !== null
                        ? ` (needs ±${status.maxAccuracyMeters} m or better)`
                        : ""
                    }`
                  : "GPS accuracy unknown"}
                {fixAgeMs !== null
                  ? ` · updated ${fixAgeMs < 2_000 ? "just now" : `${Math.round(fixAgeMs / 1_000)} s ago`}`
                  : ""}
              </p>
              {accuracyTooLow ? (
                <p className="pl-6 text-xs text-warning-text">
                  Your phone is guessing from Wi-Fi or the mobile network, which can be
                  hundreds of metres out. Step outside, wait a few seconds, and this
                  sharpens on its own.
                </p>
              ) : outsideFence && status.location ? (
                <p className="pl-6 text-xs text-danger-text">
                  Attendance is allowed within {status.location.radiusMeters} m of{" "}
                  {status.location.name}. Move closer and this updates on its own.
                </p>
              ) : fixStale ? (
                <p className="pl-6 text-xs text-warning-text">
                  Waiting for a fresher reading…
                </p>
              ) : null}
              {/* A hint, not a refusal: the mark goes through either way,
                  with the accuracy on the record. */}
              {roughReading ? (
                <p className="pl-6 text-xs text-warning-text">
                  Your phone&apos;s reading is rough (±{Math.round(geo.coords.accuracy)} m).
                  If the distance looks wrong, step outside for a moment.
                </p>
              ) : null}
              {/* The raw pair, so a disagreement between the phone and the
                  stored office can be settled by looking rather than by
                  arguing about a single number. */}
              <p className="pl-6 text-[11px] text-muted-foreground/80">
                You:{" "}
                <a
                  className="underline underline-offset-2"
                  href={`https://www.google.com/maps?q=${geo.coords.latitude},${geo.coords.longitude}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {geo.coords.latitude.toFixed(5)}, {geo.coords.longitude.toFixed(5)}
                </a>
                {status.location ? (
                  <>
                    {" · "}
                    {status.location.name}:{" "}
                    <a
                      className="underline underline-offset-2"
                      href={`https://www.google.com/maps?q=${status.location.latitude},${status.location.longitude}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {status.location.latitude.toFixed(5)},{" "}
                      {status.location.longitude.toFixed(5)}
                    </a>
                  </>
                ) : null}
              </p>
            </div>
          ) : geo.kind === "locating" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Finding your location…
            </p>
          ) : geo.kind === "denied" ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm">
                <MapPinOff className="size-4 shrink-0 text-danger-text" aria-hidden />
                Location permission was refused
              </p>
              <p className="text-xs text-muted-foreground">
                Attendance needs your location to confirm you are at{" "}
                {status.location?.name ?? "the office"}. Allow location access for this site,
                then try again. If your phone said it could not ask, another app is drawing
                over the screen &mdash; close it and try again.
              </p>
              <Button size="sm" variant="outline" onClick={locate}>
                <RefreshCw className="size-4" aria-hidden />
                Try again
              </Button>
            </div>
          ) : geo.kind === "unavailable" ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm">
                <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
                {geo.message}
              </p>
              <Button size="sm" variant="outline" onClick={locate}>
                <RefreshCw className="size-4" aria-hidden />
                Try again
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={locate}>
              <MapPin className="size-4" aria-hidden />
              Get my location
            </Button>
          )}

          {status.location ? (
            <p className="mt-2 text-xs text-muted-foreground">
              You must be within {status.location.radiusMeters} m of{" "}
              {status.location.name}.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---------- the button ---------- */}
      {prepareStep ? (
        <>
          <Button
            size="lg"
            className="h-14 w-full text-base"
            onClick={() => {
              if (prepareStep === "camera") void startCamera();
              else locate();
            }}
          >
            {prepareStep === "camera" ? (
              <Camera className="size-5" aria-hidden />
            ) : (
              <MapPin className="size-5" aria-hidden />
            )}
            {prepareStep === "camera" ? "Turn on the camera" : "Get my location"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {prepareStep === "camera"
              ? status.requireGps
                ? "Your browser will ask for the camera. Your location is asked for next."
                : "Your browser will ask for permission to use the camera."
              : "Your browser will ask for permission to use your location."}
          </p>
        </>
      ) : (
        <>
          {canRetake ? (
            /**
             * The way to clear a doubted check-in from the phone. The same
             * capture as the big button, sent as a CHECK_IN on purpose: the
             * server re-checks the mark that is waiting and, if the face
             * matches this time, confirms it on the spot without touching the
             * time. Not held to the five-minute wait -- nothing is being
             * checked out.
             */
            <div className="space-y-1.5">
              <Button
                size="lg"
                className="w-full"
                variant="outline"
                loading={busy && retaking}
                disabled={!ready}
                onClick={() => void submit(false, "CHECK_IN")}
              >
                <ScanFace className="size-5" aria-hidden />
                Retake photo
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Your check-in is waiting to be confirmed. A clearer photo that matches
                confirms it now; your time does not change.
              </p>
            </div>
          ) : null}

          <Button
            size="lg"
            className="h-14 w-full text-base"
            variant={action === "CHECK_IN" ? "primary" : "secondary"}
            loading={busy && !retaking}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {action === "CHECK_IN" ? (
              <LogIn className="size-5" aria-hidden />
            ) : (
              <LogOut className="size-5" aria-hidden />
            )}
            {action === "CHECK_IN" ? "Check in" : "Check out"}
          </Button>

          {!canSubmit && !busy ? (
            <p className="text-center text-xs text-muted-foreground">
              {/* Being outside the fence is not a permission problem, and
                  saying "location access is needed" while the screen shows
                  a perfectly good reading reads as a fault in the app. A
                  refused reading is named as that, not as a distance:
                  "you are outside" to somebody standing inside was the
                  other way this line misled. The wait after a check-in
                  comes first: it clears by itself, and it says when. */}
              {checkoutTooSoon
                ? `${
                    minutesSinceCheckIn === 0
                      ? "You checked in just now."
                      : `You checked in ${minutesSinceCheckIn} min ago.`
                  } Check out is available from ${checkoutOpensAt}.`
                : accuracyTooLow
                  ? "Waiting for a more accurate location reading. Step outside for a moment and it sharpens on its own."
                  : outsideFence && status.location
                    ? `You are outside ${status.location.name}. Attendance can only be marked within ${status.location.radiusMeters} m of it.`
                    : fixStale
                      ? "Waiting for a fresh location reading."
                      : geoBlocked && cameraBlocked
                        ? "Location and camera access are both needed before you can mark attendance."
                        : geoBlocked
                          ? "Location access is needed before you can mark attendance."
                          : "Camera access is needed before you can mark attendance."}
            </p>
          ) : null}
        </>
      )}

      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        The time recorded is the server&apos;s, not your device&apos;s.
      </p>

      {/**
       * One dialog, two ways forward.
       *
       * A face that will not match is not an error to be read and dismissed --
       * it is a fork, and the two branches are try again or get a PIN from
       * somebody who can issue one. Before this, a refusal set some state that
       * nothing rendered, so the screen simply did nothing and the employee was
       * left standing there.
       */}
      <Dialog
        open={faceFailure !== null}
        onOpenChange={(open) => {
          if (open) return;
          setFaceFailure(null);
          setShowPinHelp(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {faceFailure === "NO_BLINK"
                ? "We did not see you blink"
                : faceFailure === "NOT_ENROLLED"
                  ? "No reference photo on file"
                  : faceFailure === "MULTIPLE_FACES"
                    ? "Somebody else is as close to the camera"
                    : "Face not matched"}
            </DialogTitle>
            <DialogDescription>
              {faceMessage ?? "That photo could not be verified against your profile."}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3">
            {showPinHelp ? (
              <div className="space-y-2">
                <p className="text-sm">
                  Ask one of these people for a one-time PIN. Mark your attendance first &mdash;
                  it will show as waiting to be confirmed on this screen &mdash; and enter the PIN
                  there to confirm it yourself. It lasts fifteen minutes and works once.
                </p>
                {pinHelp === null ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> Finding out who can help&hellip;
                  </p>
                ) : pinHelp.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nobody has been given that power yet. Ask an administrator &mdash; they can
                    grant it on the attendance settings screen.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {pinHelp.map((person) => (
                      <li key={`${person.name}-${person.designation ?? ""}`} className="px-3 py-2">
                        <p className="text-sm font-medium">{person.name}</p>
                        {person.designation ? (
                          <p className="text-xs text-muted-foreground">{person.designation}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {/* A retake cannot be "marked anyway": the mark exists. So
                    the offer is left out and the advice is only how to
                    retry. Somebody else in the frame is the one refusal
                    where better light is not the answer. */}
                {canMarkAnyway && !retakeFailed
                  ? "You have tried enough times. Mark it anyway and an administrator will confirm it from your photo \u2014 your attendance is recorded either way."
                  : faceFailure === "NOT_ENROLLED"
                    ? retakeFailed
                      ? "There is no photo on your profile to compare against, so trying again will not help. Ask HR to add your photo; an administrator will confirm today's mark."
                      : "There is no photo on your profile to compare against, so trying again will not help. Mark it anyway and an administrator will confirm it, or ask HR to add your photo."
                    : faceFailure === "MULTIPLE_FACES"
                      ? "Step apart so only you are in the frame, then retry."
                      : retakeFailed
                        ? "Try again in better light, holding the phone at eye level. If it still will not match, an administrator will confirm your mark from the photo."
                        : "Try again in better light, holding the phone at eye level. If it still will not match, you can mark it anyway and somebody will confirm it."}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            {showPinHelp ? (
              <Button variant="outline" onClick={() => setShowPinHelp(false)}>
                Back
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  setShowPinHelp(true);
                  // Fetched on demand: most refusals are a second attempt away,
                  // and nobody needs this list unless they ask for it.
                  if (pinHelp === null) {
                    void api<{ people: { name: string; designation: string | null }[] }>(
                      "/api/attendance/pin-help",
                    )
                      .then((r) => setPinHelp(r.people))
                      .catch(() => setPinHelp([]));
                  }
                }}
              >
                Check with PIN
              </Button>
            )}
            {canMarkAnyway && !retakeFailed ? (
              /**
               * The way out, and it only appears once trying again has stopped
               * being useful.
               *
               * Measured before it was built: one employee's check-out was
               * refused fourteen times in a row on a live instance and never
               * went through. A camera that will not co-operate should cost
               * somebody a moment, not a day.
               */
              <Button
                variant="secondary"
                onClick={() => {
                  setFaceFailure(null);
                  setShowPinHelp(false);
                  setFaceStage("idle");
                  setFaceMessage(null);
                  void submit(true, failedType);
                }}
                disabled={busy}
              >
                Mark anyway
              </Button>
            ) : null}
            <Button
              onClick={() => {
                setFaceFailure(null);
                setShowPinHelp(false);
                setFaceStage("idle");
                setFaceMessage(null);
                void submit(false, failedType);
              }}
              disabled={busy}
            >
              <RefreshCw className="size-4" aria-hidden />
              Retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
