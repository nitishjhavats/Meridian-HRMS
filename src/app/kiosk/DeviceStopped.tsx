"use client";

import { useState } from "react";
import { MonitorOff } from "lucide-react";

/**
 * What a reception tablet shows when its device account can no longer mark.
 *
 * The branch was switched off, or the device row was revoked. The screen used
 * to keep yesterday's roster and refuse every tap; now the roster refresh
 * reloads this page, and this is what the next person who walks up reads --
 * a sentence, and a way for an administrator to sign the device out.
 */
export function DeviceStopped({ message }: { message: string }) {
  const [leaving, setLeaving] = useState(false);

  async function signOut() {
    setLeaving(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <MonitorOff className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">This device has been switched off</h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Mark attendance on your own phone for now. An administrator can switch the device or its
        location back on under Settings &rarr; Attendance.
      </p>
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={leaving}
        className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-60"
      >
        {leaving ? "Signing out…" : "Sign this device out"}
      </button>
    </main>
  );
}
