"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";

/**
 * Uploading the mark that appears on the sign-in screen, beside the name in the
 * app, and as the installed app's icon.
 *
 * A plain multipart POST rather than the shared JSON client, because the shared
 * one serialises to JSON and a file is not JSON. The server re-encodes and
 * strips metadata on the way in, so what lands is a clean image regardless of
 * what came out of a phone.
 */
export function LogoUploader({
  endpoint,
  currentLogoUrl,
  label,
  hint,
}: {
  endpoint: string;
  currentLogoUrl: string | null;
  label: string;
  hint: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browser caches the logo URL, and it does not change when the image
  // behind it does. A cache-buster on the preview keeps the change visible.
  const [stamp, setStamp] = useState(0);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch(endpoint, { method: "POST", body });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? "That image was not accepted.");
        return;
      }
      toast.success("Logo updated.");
      if (input.current) input.current.value = "";
      setStamp(Date.now());
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        setError("The logo was not removed.");
        return;
      }
      toast.success("Logo removed.");
      setStamp(Date.now());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const preview = currentLogoUrl ? `${currentLogoUrl}?v=${stamp}` : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
          {preview ? (
            <img src={preview} alt={`${label} logo`} className="size-full object-contain" />
          ) : (
            <ImageUp className="size-6 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={input}
          type="file"
          // Without this it is announced as "Choose file, no file chosen", with
          // no indication of which logo is being replaced.
          aria-label={`Upload a logo for ${label}`}
          accept="image/png,image/jpeg,image/webp"
          className="max-w-xs"
          onChange={upload}
          disabled={busy}
        />
        {currentLogoUrl ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={remove}>
            <Trash2 className="size-4" aria-hidden />
            Remove
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        A square PNG with a transparent background works best — it is padded, never cropped,
        so a wide wordmark stays readable as an app icon.
      </p>
    </div>
  );
}
