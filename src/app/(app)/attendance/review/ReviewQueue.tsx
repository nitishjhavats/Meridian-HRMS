"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ImageOff, ScanFace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * Two photos, side by side, and a decision.
 *
 * The only question an administrator is actually being asked here is "is this
 * the same person", and the only way to answer it is to see both pictures at
 * once. Everything else on the card — the score, the distance, the time — is
 * context for the cases where the answer is not obvious from the faces.
 *
 * Rejecting requires a reason because the employee is told what it was, and
 * "your attendance was not accepted" with no explanation is worse than the
 * flag it replaces.
 */

interface FlaggedEvent {
  id: string;
  occurredAt: string;
  type: string;
  employee: { id: string; name: string; employeeCode: string };
  selfieUrl: string | null;
  selfiePurged: boolean;
  referenceUrl: string | null;
  faceMatchScore: number | null;
  faceMatchReason: string | null;
  distanceMeters: number | null;
  /**
   * How rough the phone's reading was, in metres, when the distance was
   * measured. The gate on it is off, so it is shown instead: 12 m from a
   * ±40 m fix is not the same evidence as 12 m from a ±5 m one.
   */
  accuracyMeters: number | null;
  withinGeofence: boolean;
  source: string;
  note: string | null;
}

/**
 * Every reason the engine can emit, spelled the way the engine spells it.
 *
 * `NO_FACE` was dead: the domain has always emitted `NO_FACE_DETECTED`, so that
 * row rendered as the fallback "Could not be verified" and an administrator was
 * told nothing at all. The blink reasons were simply absent, and they are about
 * to become the most common thing in this queue.
 */
const REASON_LABEL: Record<string, string> = {
  NO_MATCH: "The face did not match the reference photo",
  NO_FACE_DETECTED: "No face was found in the photo",
  MULTIPLE_FACES: "Somebody else was as close to the camera",
  LOW_QUALITY: "The photo was too unclear to check",
  NOT_ENROLLED: "They have no reference photo enrolled",
  ENGINE_UNAVAILABLE: "Face matching was not running on the server",
  NO_BLINK: "They did not blink while the camera was recording",
  BLINK_UNKNOWN: "The camera could not tell whether they blinked",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ReviewQueue({
  initial,
  threshold,
}: {
  initial: FlaggedEvent[];
  /**
   * The organisation's own threshold, not a number written into this file.
   *
   * It said "the threshold is 36%" in prose. The field is writable through the
   * settings API, so the sentence was one save away from being false on a
   * screen whose entire purpose is helping somebody judge a number.
   */
  threshold: number;
}) {
  const router = useRouter();
  const [events, setEvents] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function decide(event: FlaggedEvent, verdict: "VERIFIED" | "REJECTED") {
    setBusy(event.id);
    const done = await mutate(
      () =>
        api(`/api/attendance/review/${event.id}`, {
          method: "POST",
          body: { verdict, note: note.trim() || undefined },
        }),
      {
        success:
          verdict === "VERIFIED"
            ? `${event.employee.name}'s attendance confirmed.`
            : "Recorded. Correct the day from the attendance grid.",
        error: "Nothing was recorded",
      },
    );
    setBusy(null);
    if (done) {
      setEvents((all) => all.filter((e) => e.id !== event.id));
      setRejecting(null);
      setNote("");
      router.refresh();
    }
  }

  if (events.length === 0) {
    return (
      <Section title="Nothing waiting">
        <EmptyState
          icon={ScanFace}
          title="No attendance is waiting to be reviewed"
          description="A mark appears here when the face check could not confirm it — usually poor light or an old camera rather than anything else."
        />
      </Section>
    );
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" title={`${events.length} waiting`}>
        These people are recorded as present. Confirming leaves the day as it is. Not accepting
        takes the mark back &mdash; the check-in time is cleared and the day goes back to what it
        was &mdash; and the photo, the score and your reason stay on the record. It is refused on a
        month whose payroll is locked or already paid.
      </Alert>

      {events.map((event) => (
        <Section
          key={event.id}
          title={event.employee.name}
          description={`${event.employee.employeeCode} · ${when(event.occurredAt)} · ${
            event.type === "CHECK_IN" ? "check-in" : "check-out"
          }`}
        >
          <div className="space-y-4 p-4">
            {/**
              * Two photos side by side, then the detail.
              *
              * This had no breakpoint anywhere in the file. The two photos were
              * a fixed 128px each and the detail column was `flex-1`, so on a
              * phone the pair took most of the width and the reason, the score
              * and the two decision buttons were squeezed into whatever was
              * left. The photos are a row of their own below `sm`, sized by the
              * screen rather than by a constant, and the detail gets the full
              * width underneath — which is where the reviewer is actually
              * reading.
              */}
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
              <div className="flex gap-3 sm:contents">
              <figure className="min-w-0 flex-1 sm:w-32 sm:flex-none">
                <div className="aspect-square overflow-hidden rounded-lg border border-border bg-muted">
                  {event.selfiePurged ? (
                    <div className="grid size-full place-items-center text-center">
                      <span className="px-2">
                        <ImageOff className="mx-auto size-6 text-muted-foreground" aria-hidden />
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          Photo deleted
                        </span>
                      </span>
                    </div>
                  ) : event.selfieUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={event.selfieUrl}
                      alt={`Photo taken when ${event.employee.name} marked attendance`}
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="grid size-full place-items-center">
                      <ImageOff className="size-6 text-muted-foreground" aria-hidden />
                    </div>
                  )}
                </div>
                <figcaption className="mt-1 text-center text-xs text-muted-foreground">
                  At the time
                </figcaption>
              </figure>

              <figure className="min-w-0 flex-1 sm:w-32 sm:flex-none">
                <div className="aspect-square overflow-hidden rounded-lg border border-border bg-muted">
                  {event.referenceUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={event.referenceUrl}
                      alt={`Reference photo enrolled for ${event.employee.name}`}
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="grid size-full place-items-center text-center">
                      <span className="px-2">
                        <ScanFace className="mx-auto size-6 text-muted-foreground" aria-hidden />
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          Not enrolled
                        </span>
                      </span>
                    </div>
                  )}
                </div>
                <figcaption className="mt-1 text-center text-xs text-muted-foreground">
                  Enrolled
                </figcaption>
              </figure>

              </div>

              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p className="font-medium">
                  {REASON_LABEL[event.faceMatchReason ?? ""] ?? "Could not be verified"}
                </p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {event.faceMatchScore !== null ? (
                    <li>
                      Similarity {Math.round(event.faceMatchScore * 100)}%, against a threshold of{" "}
                      {Math.round(threshold * 100)}%
                    </li>
                  ) : (
                    <li>
                      No similarity was measured &mdash; there was no face to compare
                    </li>
                  )}
                  <li>
                    {event.withinGeofence
                      ? `Inside the geofence${
                          event.distanceMeters !== null ? `, ${event.distanceMeters} m away` : ""
                        }${event.accuracyMeters !== null ? ` (fix ±${event.accuracyMeters} m)` : ""}`
                      : "No geofence was checked for this mark"}
                  </li>
                  <li>Marked from {event.source === "KIOSK" ? "an office device" : "their own device"}</li>
                  {event.note ? <li>{event.note}</li> : null}
                </ul>
              </div>
            </div>

            {rejecting === event.id ? (
              <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                <Field
                  label="Why not?"
                  htmlFor={`note-${event.id}`}
                  required
                  hint={`${event.employee.name} is told what you write here.`}
                >
                  <Input
                    id={`note-${event.id}`}
                    value={note}
                    placeholder="The photo is of somebody else"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === event.id}
                    disabled={busy !== null || note.trim().length < 3}
                    onClick={() => void decide(event, "REJECTED")}
                  >
                    Record and tell them
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setRejecting(null);
                      setNote("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={busy === event.id}
                  disabled={busy !== null}
                  onClick={() => void decide(event, "VERIFIED")}
                >
                  <Check className="size-4" aria-hidden />
                  That is them
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setRejecting(event.id);
                    setNote("");
                  }}
                >
                  <X className="size-4" aria-hidden />
                  Not accepted
                </Button>
                {event.referenceUrl === null ? (
                  <Badge tone="warning">No reference photo to compare</Badge>
                ) : null}
              </div>
            )}
          </div>
        </Section>
      ))}
    </div>
  );
}
