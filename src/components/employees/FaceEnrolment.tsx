"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ScanFace, ShieldAlert, Trash2, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { BRAND } from "@/lib/brand";
import { formatDate } from "@/lib/utils";

/**
 * The reference photo attendance selfies are matched against.
 *
 * Enrolment is stricter than a daily check-in on purpose: the server refuses a
 * photo it cannot read a single clear face from, because a poor reference
 * quietly breaks every future comparison and produces months of mysterious
 * mismatches nobody can explain.
 *
 * The photo is uploaded; the face descriptor is computed on the server and never
 * comes back. There is no API that returns it.
 */
export function FaceEnrolment({
  employeeId,
  employeeName,
  enrolled,
  enrolledAt,
  photoUrl,
  engineAvailable,
  canManage,
  isSelf,
}: {
  employeeId: string;
  employeeName: string;
  enrolled: boolean;
  enrolledAt: Date | string | null;
  photoUrl: string | null;
  engineAvailable: boolean;
  canManage: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * Ticked by a person, not set by the client.
   *
   * This used to be `if (isSelf) form.set("consent", "true")` — the browser
   * asserting consent on the employee's behalf, with no statement shown and no
   * box to tick, and nothing at all recorded when HR enrolled somebody else.
   * A face is biometric data; the consent has to be given, not assumed.
   */
  const [consented, setConsented] = useState(false);

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    setPreview(URL.createObjectURL(file));

    try {
      const form = new FormData();
      form.set("photo", file);
      form.set("consent", "true");

      const response = await fetch(`/api/employees/${employeeId}/face`, {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new RequestFailed(payload.error, response.status);

      toast.success("Reference photo enrolled", {
        description: `Face detected with ${Math.round(payload.quality * 100)}% confidence.`,
      });
      setPreview(null);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof RequestFailed
          ? err.error.message
          : "We could not upload that photo. Try again.",
      );
      setPreview(null);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    const result = await mutate(
      () => api(`/api/employees/${employeeId}/face`, { method: "DELETE" }),
      { success: "Reference photo removed." },
    );
    setBusy(false);
    if (result !== null) router.refresh();
  }

  return (
    <div className="space-y-3 p-4">
      {!engineAvailable ? (
        <Alert tone="warning" title="Face verification is not running">
          The recognition models are not installed on this server, so selfies are stored but not
          checked, and a reference photo cannot be {enrolled ? "replaced" : "added"} until they
          are &mdash; enrolment reads the face from the photo, and there is nothing to read it
          with. Run <code className="font-mono">npm run face:models</code> to enable it.
        </Alert>
      ) : null}

      <div className="flex items-start gap-4">
        <div className="size-24 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
          {preview ?? photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview ?? photoUrl!}
              alt={`Reference photo for ${employeeName}`}
              className="size-full object-cover"
            />
          ) : (
            <div className="grid size-full place-items-center">
              <ScanFace className="size-8 text-muted-foreground" aria-hidden />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Reference photo</p>
            <Badge tone={enrolled ? "success" : "neutral"}>
              {enrolled ? "enrolled" : "not enrolled"}
            </Badge>
          </div>

          <p className="mt-0.5 text-xs text-muted-foreground">
            {enrolled
              ? `Enrolled ${enrolledAt ? formatDate(enrolledAt) : ""}. Attendance selfies are matched against this.`
              : "Without one, attendance selfies are stored but cannot be verified."}
          </p>

          {canManage && !enrolled ? (
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
              />
              <span className="text-muted-foreground">
                {isSelf ? (
                  <>
                    I agree to {BRAND.name} storing a reference photo of my face and a numerical
                    face template, and using them to verify my attendance. Matching runs on this
                    server; my photo is not sent to any third party. I can withdraw this at any
                    time by removing the photo, which deletes the template with it.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">
                      {employeeName} has agreed to face verification.
                    </span>{" "}
                    They have been told that a reference photo and a numerical face template will
                    be stored and used to verify their attendance, that matching runs on this
                    server, and that they can withdraw at any time. This is recorded against their
                    record with today&rsquo;s date.
                  </>
                )}
              </span>
            </label>
          ) : null}

          {canManage ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture={isSelf ? "user" : undefined}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                loading={busy}
                // Replacing an existing photo does not re-ask: consent was
                // given for face verification, not for one particular JPEG.
                //
                // Off while the engine is down. The server refuses every
                // upload then ("Face verification is unavailable, so this
                // photo cannot be enrolled yet"), so a live button was a
                // preview that flashed and an error on every try; the alert
                // above says why it is off. Remove stays on -- deleting a
                // photo reads no face.
                disabled={busy || !engineAvailable || (!enrolled && !consented)}
                title={
                  engineAvailable
                    ? undefined
                    : "Face verification is not running on this server, so a photo cannot be enrolled yet."
                }
                onClick={() => fileRef.current?.click()}
              >
                {isSelf ? (
                  <Camera className="size-4" aria-hidden />
                ) : (
                  <Upload className="size-4" aria-hidden />
                )}
                {enrolled ? "Replace photo" : "Add photo"}
              </Button>

              {enrolled ? (
                <Button size="sm" variant="ghost" loading={busy} onClick={remove}>
                  <Trash2 className="size-4" aria-hidden />
                  Remove
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <p className="flex gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
        <span>
          This is biometric data. The face descriptor is encrypted on this server, never sent to
          any third party, never returned to a browser, and is deleted along with the photo when
          the enrolment is removed.
        </span>
      </p>
    </div>
  );
}
