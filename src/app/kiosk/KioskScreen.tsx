"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  KeyRound,
  ListChecks,
  LogOut,
  ScanFace,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { useFrameHint } from "@/components/attendance/useFrameHint";
import {
  BLINK_LEAD_MS,
  BURST_FRAMES,
  BURST_GAP_MS,
  blinkWindowSeconds,
} from "@/domain/attendance/capture";
import { KioskMonth } from "./KioskMonth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { initials } from "@/lib/utils";

/**
 * The screen in the reception.
 *
 * Three states and nothing else: the roster, one person's camera, and a result
 * that clears itself. Everything is sized for somebody standing at arm's length
 * with a bag in one hand.
 *
 * Two behaviours matter more than they look:
 *
 *   - the result clears on a timer and returns to the roster, so the next person
 *     in the queue is never looking at somebody else's name and status;
 *   - a pending app update is applied here automatically. Elsewhere the product
 *     asks first, because reloading underneath somebody mid-form is its own bug.
 *     A screen in a reception has nobody to ask, and it is the one device that
 *     will sit on the same page for a month.
 */

interface Device {
  deviceId: string;
  label: string;
  organizationName: string;
  workLocation: { id: string; name: string; addressLines: string[] };
  rosterScope: "ORGANISATION" | "WORK_LOCATION";
}

interface RosterEntry {
  id: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  department: string | null;
  workLocation: string | null;
  faceEnrolled: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

type Stage =
  | { kind: "roster" }
  | { kind: "capture"; person: RosterEntry }
  | { kind: "bypass"; person: RosterEntry; mode: "PIN" | "SUPERVISOR"; reason: string }
  // Somebody's own month, read at the device. Not part of marking attendance,
  // which is why it is a stage of its own rather than a dialog over the roster:
  // it is a thing to stand and read, and the roster behind it is noise.
  | { kind: "month"; person: RosterEntry; view: "calendar" | "summary" }
  | { kind: "done"; name: string; type: string; status: string; late: number; bypassed: boolean };

const RESULT_SECONDS = 5;

/**
 * The burst the liveness check needs, matching the phone panel exactly.
 *
 * Eight frames roughly 180 ms apart is about a second and a half -- long enough
 * that a blink, which lasts a third of a second, cannot fall between two of
 * them, and short enough that a queue at a reception desk does not form.
 */
/**
 * How often a device left alone looks for a new build.
 *
 * Ten minutes: often enough that a deploy reaches the wall within one tea
 * break, rare enough that it is not a request every few seconds from a screen
 * that may be on a metered connection.
 */
const UPDATE_CHECK_MS = 10 * 60 * 1000;
/** How often the roster is re-read while the screen sits on the wall. */
const ROSTER_REFRESH_MS = 60 * 1000;


export function KioskScreen({
  device,
  initialRoster,
  organizationLogoUrl,
  platformLogoUrl,
  maker,
  impersonating,
}: {
  device: Device;
  initialRoster: RosterEntry[];
  organizationLogoUrl: string | null;
  platformLogoUrl: string | null;
  maker: { name: string; website: string; websiteLabel: string };
  /** The superadmin acting as this device, if anybody is. */
  impersonating: string | null;
}) {
  const [roster, setRoster] = useState(initialRoster);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "roster" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read inside long-lived listeners without re-subscribing them.
  const stageRef = useRef(stage);
  const busyRef = useRef(busy);
  stageRef.current = stage;
  busyRef.current = busy;
  /** What the capture is asking of the person right now. */
  const [prompt, setPrompt] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  /**
   * The server's reason for refusing a face, while the fork is on screen.
   *
   * A refusal is not an error message, it is a choice between two things:
   * stand in better light and try again, or get a PIN from somebody who can
   * issue one. This screen used to put every refusal into one red alert at the
   * top, which is a sentence to re-read rather than a way through the door.
   */
  const [faceFailure, setFaceFailure] = useState<{
    reason: string;
    message: string;
    /** After how many refusals "Mark anyway" appears. `null` = never, here. */
    reviewAfterAttempts: number | null;
  } | null>(null);
  /**
   * Consecutive refusals for the person currently at the device.
   *
   * Reset whenever somebody new is chosen, because it is a property of this
   * attempt at this mark and not of the machine. A reception device is used by
   * thirty people in ten minutes; carrying a count between them would offer the
   * fourth person an escape they had not earned.
   */
  const [faceAttempts, setFaceAttempts] = useState(0);

  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  /**
   * Live advice about the light, the same the phone has had all along.
   *
   * The reception screen's only guidance was a hardcoded "Blink now", so the
   * two things that actually stop a face matching — a dark desk, a window
   * behind the person — were only reported after submitting, as "that photo was
   * too blurry or dark to check". Now they are on screen while there is still
   * something to do about them.
   */
  const frameHint = useFrameHint(video, stage.kind === "capture" && !busy);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/kiosk", { cache: "no-store" });
      /**
       * Signed out, revoked, or its branch switched off: the server said so,
       * and this screen used to swallow it and keep yesterday's list on the
       * wall. A full load of /kiosk lets the layout decide where a device in
       * that state belongs -- the login screen, or a plain message.
       */
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        window.location.href = "/kiosk";
        return;
      }
      if (!response.ok) return;
      const data = (await response.json()) as { roster: RosterEntry[] };
      setRoster(data.roster);
      // The capture and bypass stages hold their own copy of the row, and the
      // mark type is read from it. A refresh that left it stale would send the
      // same wrong type again on retry.
      setStage((s) => {
        if (s.kind !== "capture" && s.kind !== "bypass") return s;
        const fresh = data.roster.find((r) => r.id === s.person.id);
        return fresh ? { ...s, person: fresh } : s;
      });
    } catch {
      // A screen that cannot reach the server keeps showing the list it has;
      // the next mark will fail loudly enough.
    }
  }, []);

  /**
   * The roster has to be today's.
   *
   * It was fetched once on load and again after each successful mark, and a
   * reception tablet is left on overnight. So the next morning every row still
   * carried yesterday's `checkedInAt`, the first tap sent CHECK_OUT, and the
   * server answered "has not checked in today". Refreshed on a timer, when the
   * tab comes back into view, and the moment the local date changes -- and
   * after a failed mark too, since a stale row is one reason a mark fails.
   */
  useEffect(() => {
    let day = new Date().toDateString();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(() => {
      const now = new Date().toDateString();
      if (now !== day) {
        day = now;
        setQuery("");
      }
      if (document.visibilityState === "visible") void refresh();
    }, ROSTER_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  /**
   * Open the camera, then show the capture screen.
   *
   * The order matters. `getUserMedia` used to run from an effect keyed on the
   * stage, which is an async continuation of the tap rather than the tap
   * itself -- and a permission request that has lost its user gesture is
   * refused outright on Android with "This site can’t ask for your
   * permission". Asking inside the handler keeps the gesture, and a device
   * whose camera cannot start never leaves the roster.
   */
  const openCapture = useCallback(
    async (person: RosterEntry) => {
      setError(null);
      // A new face at the device is a new attempt from zero. A reception screen
      // serves thirty people in ten minutes; carrying a count between them
      // would offer the fourth person an escape they had not earned.
      setFaceAttempts(0);
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } },
          audio: false,
        });
      } catch {
        setError(
          "The camera on this device could not be started. Allow camera access for this site, and close any app drawing over the screen.",
        );
        return;
      }
      setStage({ kind: "capture", person });
    },
    [],
  );

  // Apply a waiting service worker while nobody is mid-flow.
  /**
   * Adopting a deploy, on a screen nobody touches.
   *
   * Three things were wrong with this, and together they meant an idle tablet
   * could sit on an old build indefinitely — which is why a bug fixed a week
   * ago could still be photographed on the wall.
   *
   *   - `registration.waiting` was read *without awaiting* `update()`, so the
   *     pass that discovers a new worker always sees `waiting === null`. The
   *     device needed a second run to adopt anything.
   *   - it ran on `[stage.kind]`, so the second run only came from somebody
   *     touching the screen. A reception device left alone never gets one.
   *   - nothing listened for `updatefound`, so a worker that becomes waiting a
   *     few seconds later was missed until the next transition.
   *
   * Now: on an interval, awaited, and listening.
   */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;

    const adopt = (registration: ServiceWorkerRegistration) => {
      // Only between people. The comment on this block always said "while
      // nobody is mid-flow" and nothing checked it: a new worker took over
      // and reloaded the page while somebody stood at the camera.
      if (stageRef.current.kind !== "roster" || busyRef.current) return;
      registration.waiting?.postMessage("SKIP_WAITING");
    };

    const check = async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (cancelled || !registration) return;
      // Awaited. Without this the read below races the fetch it depends on.
      await registration.update().catch(() => undefined);
      if (cancelled) return;
      adopt(registration);

      // And a worker that finishes installing after this pass.
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (!cancelled && installing.state === "installed") adopt(registration);
        });
      });
    };

    void check();
    const timer = setInterval(() => void check(), UPDATE_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Attach the stream `openCapture` already acquired. Nothing is requested
  // here: by the time this runs the tap that authorised it is long gone.
  useEffect(() => {
    if (stage.kind !== "capture") {
      stopCamera();
      return;
    }
    if (video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current.play().catch(() => undefined);
    }
    return () => {
      stopCamera();
    };
  }, [stage, stopCamera]);

  // The result clears itself, so a queue never reads somebody else's outcome.
  useEffect(() => {
    if (stage.kind !== "done") return;
    const timer = setTimeout(() => {
      setStage({ kind: "roster" });
      setQuery("");
      void refresh();
    }, RESULT_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [stage, refresh]);

  async function capture(): Promise<Blob | null> {
    const el = video.current;
    if (!el || el.readyState < 2) return null;
    const size = Math.min(el.videoWidth, el.videoHeight) || 640;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(el, (el.videoWidth - size) / 2, (el.videoHeight - size) / 2, size, size, 0, 0, size, size);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9));
  }

  /**
   * A burst, because a still frame cannot tell a person from a photograph.
   *
   * This screen is the *enforced* path -- it forces REQUIRED matching and
   * blocks anybody without a reference photo -- so it was the one place where a
   * printed photo held up to the lens defeated every check the product had.
   *
   * `prompt` is what the screen says while it runs, and the order of the two
   * things it says is the fix: the instruction used to land two frames into a
   * 1.4-second burst, which is 360 ms -- less than the time it takes to read
   * it. See `domain/attendance/capture.ts`.
   */
  async function captureBurst(): Promise<{ frames: Blob[]; still: Blob } | null> {
    const frames: Blob[] = [];

    // One frame with their eyes open first: it is the photo an administrator
    // reviews, and it should be a face rather than a person mid-blink.
    setPrompt("Look at the camera");
    const still = await capture();
    if (still) frames.push(still);

    /**
     * The instruction, then a pause, then the recording.
     *
     * "Blink now" used to appear at the third frame of a 1.4-second capture and
     * the whole thing was over before most people had finished reading it —
     * sixteen refusals out of eighteen marks in a morning, every one of them
     * before the identity check even ran.
     */
    setPrompt(`Blink now · ${blinkWindowSeconds()}s`);
    await new Promise((r) => setTimeout(r, BLINK_LEAD_MS));

    for (let i = frames.length; i < BURST_FRAMES; i++) {
      const frame = await capture();
      if (frame) frames.push(frame);
      if (i < BURST_FRAMES - 1) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
    }

    setPrompt(null);
    if (frames.length === 0) return null;
    return { frames, still: frames[0] as Blob };
  }

  async function submit(person: RosterEntry, extra?: FormData, acceptForReview = false) {
    setBusy(true);
    setError(null);

    const body = extra ?? new FormData();
    body.set("employeeId", person.id);
    body.set("type", person.checkedInAt ? "CHECK_OUT" : "CHECK_IN");
    body.set("deviceInfo", JSON.stringify({ screen: `${window.screen.width}x${window.screen.height}` }));
    if (acceptForReview) body.set("acceptForReview", "true");

    if (!extra) {
      const burst = await captureBurst();
      if (!burst) {
        setBusy(false);
        setError("The camera did not produce a photo. Try again.");
        return;
      }
      body.set("selfie", burst.still, "selfie.jpg");
      burst.frames.forEach((frame, i) => body.append("frames", frame, `frame-${i}.jpg`));
    }

    try {
      const response = await fetch("/api/kiosk/mark", { method: "POST", body });
      const payload = (await response.json().catch(() => null)) as
        | { name: string; type: string; status: string; lateMinutes: number; bypassed: boolean }
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        const error = (payload as {
          error?: {
            message?: string;
            details?: { face?: string; reviewAfterAttempts?: number | null };
          };
        } | null)?.error;
        const message = error?.message ?? "That could not be recorded.";
        // A face refusal carries its reason, so it becomes a choice rather
        // than a sentence. Anything else is still just an error.
        if (error?.details?.face) {
          setFaceAttempts((n) => n + 1);
          setFaceFailure({
            reason: error.details.face,
            message,
            reviewAfterAttempts: error.details.reviewAfterAttempts ?? null,
          });
        } else {
          setError(message);
          // A refused mark is often a stale row -- "nothing to check out from"
          // because the list is from yesterday. Read it again now.
          void refresh();
        }
        return;
      }

      const ok = payload as { name: string; type: string; status: string; lateMinutes: number; bypassed: boolean };
      setFaceAttempts(0);
      stopCamera();
      setStage({
        kind: "done",
        name: ok.name,
        type: ok.type,
        status: ok.status,
        late: ok.lateMinutes,
        bypassed: ok.bypassed,
      });
    } catch {
      setError("This device cannot reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Whether trying again has stopped being the useful thing to offer.
   *
   * The server's answer for this particular reason, not a number this screen
   * chose: `null` means the organisation's policy leaves no way through, and
   * the button must not appear at all.
   */
  const kioskCanMarkAnyway =
    faceFailure?.reviewAfterAttempts != null && faceAttempts >= faceFailure.reviewAfterAttempts;

  const filtered = roster.filter((r) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return r.name.toLowerCase().includes(q) || r.employeeCode.toLowerCase().includes(q);
  });

  return (
    /**
     * A frame, not a page.
     *
     * `h-dvh` was not enough, and the reason is worth keeping.
     *
     * It makes this element exactly one viewport tall, which is correct — and
     * says nothing about what sits *beside* it in the body. `<body>` is
     * `min-h-dvh` and the root layout renders `<OnlineStatus />` as a sibling of
     * `{children}`: a `position: sticky` banner, which is **in flow**. The
     * moment a reception tablet reports itself offline the document becomes
     * `100dvh + banner` and scrolls again — the same arithmetic as the
     * `body { padding-bottom }` bug that was killed here once already, arriving
     * from a new direction. The next person to add something to the root layout
     * would have done it a third time.
     *
     * `fixed inset-0` is resolved against the viewport and removed from flow, so
     * `documentElement.scrollHeight` can never exceed the viewport whatever the
     * root layout does. `overscroll-none` stops the rubber-band that let a swipe
     * on a short roster drag the whole frame — which is what the screenshots
     * caught: header gone at one end, Broadmate line appearing at the other.
     *
     * This was `min-h-dvh` with the header and footer as ordinary in-flow
     * elements and no scroll container anywhere -- so the *document* scrolled,
     * and the moment the roster was taller than the screen you could see the
     * organisation name or the Broadmate line but never both. `h-dvh` with
     * `overflow-hidden` means the page itself has nothing to scroll; the header
     * and footer hold their place and the roster moves between them.
     */
    <div className="fixed inset-0 flex flex-col overflow-hidden overscroll-none">
      {/* ---- whose room this is, and who built the software ---- */}
      {impersonating ? (
        <div className="shrink-0 bg-amber-500/15 px-6 py-2 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            You are looking at this device as {impersonating}. Nothing you do here is recorded as
            attendance.
          </span>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              stopCamera();
              await fetch("/api/platform/impersonation", { method: "DELETE" }).catch(
                () => undefined,
              );
              window.location.href = "/platform";
            }}
          >
            End support visit
          </Button>
          </div>
        </div>
      ) : null}

      {/**
        * Two rows on a phone, one on a tablet.
        *
        * This was a single flex row with no `min-w-0` and no `truncate` on the
        * text — while the roster cards three inches below it had both. So on a
        * phone a long organisation name wrapped, the clock was squeezed into the
        * corner, and the two of them traded places depending on which was
        * longer: "upar ka organisation dikh raha to broadmate gayab aur broadmate
        * ka dikhe to organisation gayab". The name and the clock are now on
        * separate tracks, and every text node can shorten itself.
        */}
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6 sm:pb-4 sm:pt-[calc(1rem+env(safe-area-inset-top))]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {organizationLogoUrl ? (
              <img
                src={organizationLogoUrl}
                alt=""
                className="size-9 shrink-0 rounded-lg object-contain sm:size-11"
              />
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold leading-tight sm:text-xl">
                {device.organizationName}
              </p>
              {/* The device name can be anything somebody typed, so it gets a
                  line of its own rather than sharing one with the branch. */}
              <p className="truncate text-xs text-muted-foreground sm:text-sm">
                {device.label} · {device.workLocation.name}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Clock />
          {/**
           * A way out.
           *
           * This screen renders no shell, which is deliberate — a device in a
           * reception is used by people who are not signed in as themselves,
           * and every link elsewhere is a link they should not follow. The cost
           * was that there was no sign-out either, so moving a tablet to
           * another office meant an administrator revoking the device and
           * creating a new one.
           *
           * Small, and behind a confirmation, because signing out strands the
           * screen until somebody walks over with the password.
           */}
          <Button
            variant="ghost"
            size="sm"
            aria-label={impersonating ? "End this support visit" : "Sign this device out"}
            title={impersonating ? "End this support visit" : "Sign this device out"}
            onClick={() => setSigningOut(true)}
          >
            <LogOut className="size-5" aria-hidden />
          </Button>
          </div>
        </div>
        {device.workLocation.addressLines.length > 0 ? (
          <p className="mt-1 truncate text-[11px] leading-tight text-muted-foreground/80 sm:mt-1.5 sm:text-xs">
            {device.workLocation.addressLines.join(", ")}
          </p>
        ) : null}
      </header>

      <Dialog open={signingOut} onOpenChange={setSigningOut}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {impersonating ? "End this support visit?" : "Sign this device out?"}
            </DialogTitle>
            <DialogDescription>
              {impersonating
                ? `You are looking at ${device.label} as a support visit. Ending it takes you back to the platform console and leaves the device signed in.`
                : `Nobody can mark attendance on ${device.label} until somebody signs it back in with the device password.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSigningOut(false)}>
              {impersonating ? "Stay here" : "Keep it signed in"}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                stopCamera();
                /**
                 * Ending a visit is not signing the device out.
                 *
                 * Posting to the sign-out route while impersonating used to
                 * revoke the *superadmin's* own session and leave the
                 * impersonation cookie behind, which is how signing back in
                 * landed them on this screen again. The route now separates the
                 * two and says which it did; the redirect follows what it says
                 * rather than assuming.
                 */
                const response = await fetch("/api/auth/logout", { method: "POST" })
                  .then((r) => r.json())
                  .catch(() => null);
                window.location.href =
                  typeof response?.redirectTo === "string" ? response.redirectTo : "/login";
              }}
            >
              <LogOut className="size-4" aria-hidden />
              {impersonating ? "End visit" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/**
        * A refused face, as a choice rather than a sentence.
        *
        * The phone has had this since the face work landed; the reception
        * screen never got it and put every refusal into one red alert at the
        * top of the page. Somebody whose face will not match in the light of a
        * particular lobby needs to be told the one thing that gets them
        * through the door, which is that a PIN exists.
        */}
      <Dialog
        open={faceFailure !== null}
        onOpenChange={(open) => {
          if (!open) setFaceFailure(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {faceFailure?.reason === "NO_BLINK" || faceFailure?.reason === "BLINK_UNKNOWN"
                ? "We did not see you blink"
                : faceFailure?.reason === "NOT_ENROLLED"
                  ? "No reference photo on file"
                  : faceFailure?.reason === "MULTIPLE_FACES"
                    ? "Somebody else is as close to the camera"
                    : "Face not matched"}
            </DialogTitle>
            <DialogDescription>{faceFailure?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/* Retrying is pointless with no photo on file, so it is not
                offered there — the only way through is a PIN. */}
            {faceFailure?.reason !== "NOT_ENROLLED" ? (
              <Button variant="secondary" onClick={() => setFaceFailure(null)}>
                <ScanFace className="size-4" aria-hidden />
                Try again
              </Button>
            ) : null}
            {kioskCanMarkAnyway ? (
              /**
               * The way out, on the device where a queue forms behind you.
               *
               * It appears only after the refusals the reason is worth -- the
               * organisation's own count for a face that will not match -- and
               * the mark it makes is always flagged. A reception screen that will not let somebody
               * through is a person standing in a lobby, and the answer to that
               * is not a better error message.
               */
              <Button
                variant="secondary"
                onClick={() => {
                  const person = stage.kind === "capture" ? stage.person : null;
                  setFaceFailure(null);
                  if (person) void submit(person, undefined, true);
                }}
              >
                Mark anyway
              </Button>
            ) : null}
            <Button
              onClick={() => {
                const person = stage.kind === "capture" ? stage.person : null;
                setFaceFailure(null);
                if (person) setStage({ kind: "bypass", person, mode: "PIN", reason: "" });
              }}
            >
              <KeyRound className="size-4" aria-hidden />
              Check with PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main id="main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6">
        {error ? (
          <Alert tone="danger" title="Not recorded">
            {error}
          </Alert>
        ) : null}

        {stage.kind === "roster" ? (
          <>
            <div className="relative mb-5 max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                className="h-12 pl-10 text-base"
                aria-label="Find your name"
                placeholder="Find your name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {/**
              * What this screen is showing, when it is not showing everybody.
              *
              * A device narrowed to one branch is a setting an administrator
              * chose somewhere else, months ago. Without a line saying so, a
              * person who cannot find their name concludes the product has
              * lost them -- which is exactly how the last roster bug was
              * reported.
              */}
            {device.rosterScope === "WORK_LOCATION" && roster.length > 0 ? (
              <p className="mb-4 text-sm text-muted-foreground">
                Showing people who work at {device.workLocation.name}.
              </p>
            ) : null}

            {/**
              * An empty roster is not an empty search.
              *
              * Before anybody had typed, a brand-new organisation -- or a
              * device narrowed to a branch with nobody assigned to it -- read
              * `Nobody matches “”.`, empty quotes and all, as if the screen
              * had misheard a name. Neither of those is something the person
              * at the tablet can fix, so the line says what is missing and,
              * for the branch case, who can put it right.
              */}
            {roster.length === 0 ? (
              <p className="text-muted-foreground">
                {device.rosterScope === "WORK_LOCATION"
                  ? `Nobody is assigned to ${device.workLocation.name} — ask an administrator.`
                  : "Nobody is on the roster — ask an administrator."}
              </p>
            ) : filtered.length === 0 ? (
              <p className="text-muted-foreground">Nobody matches “{query}”.</p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((person) => (
                  <li
                    key={person.id}
                    className="relative rounded-xl border border-border bg-card transition-colors hover:border-primary"
                  >
                    <button
                      type="button"
                      onClick={() => void openCapture(person)}
                      className="flex w-full items-center gap-3 rounded-xl p-4 pr-16 text-left transition-colors hover:bg-muted"
                    >
                      {person.photoUrl ? (
                        <img
                          src={person.photoUrl}
                          alt=""
                          className="size-14 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-primary-muted text-lg font-semibold text-primary">
                          {initials(person.name)}
                        </span>
                      )}
                      {/* Wraps, never cuts: with three tiles across a 1024px
                          tablet the text column is about 160px, and "ACM003 -
                          Human Resources" lost its last word. A tile a line
                          taller is still one tile; a department that reads
                          "Human Resou..." is a guess. */}
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-base font-medium">{person.name}</span>
                        <span className="block break-words text-sm text-muted-foreground">
                          {person.employeeCode}
                          {person.department ? ` · ${person.department}` : ""}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {person.checkedOutAt ? (
                            <Badge tone="neutral">Done for today</Badge>
                          ) : person.checkedInAt ? (
                            <Badge tone="info">Checked in</Badge>
                          ) : null}
                          {!person.faceEnrolled ? (
                            <Badge tone="warning">Face not set up</Badge>
                          ) : null}
                        </span>
                      </span>
                    </button>

                    {/**
                      * One capsule to the right of the name, split in two.
                      *
                      * These were a bar across the bottom of the card, which
                      * added a row to every tile and made the roster taller —
                      * on the one screen where the roster has to stay glanceable
                      * from two metres away. Absolutely positioned inside the
                      * card so it costs no height at all: the card is the same
                      * thickness it was before the buttons existed, and the
                      * name button reserves room for it with `pr-16` rather
                      * than sliding underneath.
                      */}
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="flex flex-col overflow-hidden rounded-full border border-border bg-background">
                        <button
                          type="button"
                          aria-label={`${person.name} — calendar`}
                          title="Calendar"
                          onClick={() => setStage({ kind: "month", person, view: "calendar" })}
                          className="grid size-9 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <CalendarDays className="size-4" aria-hidden />
                        </button>
                        <span className="h-px bg-border" aria-hidden />
                        <button
                          type="button"
                          aria-label={`${person.name} — this month`}
                          title="This month"
                          onClick={() => setStage({ kind: "month", person, view: "summary" })}
                          className="grid size-9 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <ListChecks className="size-4" aria-hidden />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {stage.kind === "capture" ? (
          <Centered>
            <p className="text-2xl font-semibold">{stage.person.name}</p>
            {/* One line that keeps talking. A reception screen is read from
                two metres away by somebody who is already half past it, so the
                instruction has to change when what is being asked changes. */}
            <p
              className={`mt-1 text-lg ${prompt ? "font-medium text-primary" : "text-muted-foreground"}`}
              role="status"
              aria-live="polite"
            >
              {prompt ??
                (busy
                  ? "Checking your face…"
                  : `${stage.person.checkedInAt ? "Checking out" : "Checking in"} · look at the camera`)}
            </p>

            {/* What the picture itself says, while there is still time to fix
                it. Only when the camera has something to complain about. */}
            {frameHint ? (
              <p className="mt-1 text-sm font-medium text-amber-600 dark:text-amber-400">
                {frameHint}
              </p>
            ) : null}

            {!stage.person.faceEnrolled ? (
              <Alert tone="warning" title="No reference photo on file">
                This device cannot verify {stage.person.name.split(" ")[0]} yet. Ask HR to add a
                photo, or use a one-time PIN below.
              </Alert>
            ) : null}

            <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-muted">
              <video
                ref={video}
                playsInline
                muted
                className="size-full scale-x-[-1] object-cover"
              />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" loading={busy} onClick={() => void submit(stage.person)}>
                <ScanFace className="size-5" aria-hidden />
                {stage.person.checkedInAt ? "Check out" : "Check in"}
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => setStage({ kind: "bypass", person: stage.person, mode: "PIN", reason: "" })}
              >
                <KeyRound className="size-5" aria-hidden />
                Use a PIN
              </Button>
              <Button variant="ghost" size="lg" onClick={() => setStage({ kind: "roster" })}>
                <X className="size-5" aria-hidden />
                Cancel
              </Button>
            </div>
          </Centered>
        ) : null}

        {stage.kind === "month" ? (
          <KioskMonth
            employeeId={stage.person.id}
            name={stage.person.name}
            view={stage.view}
            onClose={() => setStage({ kind: "roster" })}
          />
        ) : null}

        {stage.kind === "bypass" ? (
          <BypassPanel
            stage={stage}
            busy={busy}
            onCancel={() => setStage({ kind: "capture", person: stage.person })}
            onSwitch={(mode) => setStage({ ...stage, mode })}
            onSubmit={(data) => void submit(stage.person, data)}
          />
        ) : null}

        {stage.kind === "done" ? (
          <Centered>
            <span className="grid size-20 place-items-center rounded-full bg-success-muted">
              <CheckCircle2 className="size-11 text-success-text" aria-hidden />
            </span>
            <p className="text-3xl font-semibold">{stage.name}</p>
            <p className="text-lg text-muted-foreground">
              {stage.type === "CHECK_IN" ? "Checked in" : "Checked out"}
              {stage.late > 0 ? ` · ${stage.late} minutes late` : ""}
            </p>
            {stage.bypassed ? (
              <p className="flex items-center gap-2 text-sm text-warning-text">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                Recorded without a face check — an administrator will see this.
              </p>
            ) : null}
            <Button variant="ghost" onClick={() => setStage({ kind: "roster" })}>
              Next person
            </Button>
          </Centered>
        ) : null}
      </main>

      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-border px-6 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 text-xs text-muted-foreground">
        {platformLogoUrl ? (
          <img src={platformLogoUrl} alt="" className="size-4 rounded object-contain" />
        ) : null}
        <span>
          Powered by {maker.name} ·{" "}
          <a href={maker.website} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
            {maker.websiteLabel}
          </a>
        </span>
        {/* Small, grey, and the whole reason it is here: a photograph of the
            tablet now answers "which build is this?". The only build identity
            that reached a client before was CACHE_VERSION inside /sw.js, which
            nobody standing in a reception can read. */}
        <span className="text-[10px] text-muted-foreground/60" title="Build">
          {process.env.NEXT_PUBLIC_BUILD_ID}
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------- small parts ------------------------------ */

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-5 py-6 text-center">
      {children}
    </div>
  );
}

function Badge({ tone, children }: { tone: "neutral" | "info" | "warning"; children: React.ReactNode }) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    info: "bg-info-muted text-foreground",
    warning: "bg-warning-muted text-warning-text",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function BypassPanel({
  stage,
  busy,
  onCancel,
  onSwitch,
  onSubmit,
}: {
  stage: { person: { name: string }; mode: "PIN" | "SUPERVISOR"; reason: string };
  busy: boolean;
  onCancel: () => void;
  onSwitch: (mode: "PIN" | "SUPERVISOR") => void;
  onSubmit: (data: FormData) => void;
}) {
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");

  function send() {
    const data = new FormData();
    if (stage.mode === "PIN") {
      data.set("pin", pin);
    } else {
      data.set("supervisorEmail", email);
      data.set("supervisorPassword", password);
      data.set("reason", reason);
    }
    onSubmit(data);
  }

  return (
    <Centered>
      <p className="text-2xl font-semibold">{stage.person.name}</p>
      <Alert tone="warning" title="This will be recorded as unverified">
        Marking without a face check is flagged for an administrator to review.
      </Alert>

      <div className="flex gap-2">
        <Button
          variant={stage.mode === "PIN" ? "primary" : "outline"}
          size="sm"
          onClick={() => onSwitch("PIN")}
        >
          One-time PIN
        </Button>
        <Button
          variant={stage.mode === "SUPERVISOR" ? "primary" : "outline"}
          size="sm"
          onClick={() => onSwitch("SUPERVISOR")}
        >
          Supervisor
        </Button>
      </div>

      {stage.mode === "PIN" ? (
        <div className="w-full max-w-xs space-y-3">
          <Input
            className="h-14 text-center text-2xl tracking-[0.4em]"
            inputMode="numeric"
            maxLength={6}
            aria-label="Six-digit PIN"
                placeholder="000000"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
          <p className="text-xs text-muted-foreground">
            Ask an administrator, your reporting manager, or anyone your organisation has named
            on the PIN authority screen. It lasts fifteen minutes and works once.
          </p>
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3 text-left">
          <Input
            type="email"
            placeholder="Supervisor&rsquo;s work email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Their password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            placeholder="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            A supervisor, a manager or an administrator. Their credentials are checked and nothing
            is signed in — this device stays as it was.
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <Button size="lg" loading={busy} onClick={send}>
          Mark attendance
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Back
        </Button>
      </div>
    </Centered>
  );
}

/** The wall clock. A device in a reception is also the thing people glance at. */
function Clock() {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }).format(new Date()),
      );
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);
  return <p className="text-xl font-semibold tabular-nums sm:text-2xl">{now}</p>;
}
