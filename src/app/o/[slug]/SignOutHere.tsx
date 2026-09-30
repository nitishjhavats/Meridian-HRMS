"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Sign out first", with the means to.
 *
 * The signed-in-elsewhere screen told people to sign out before using another
 * account on this door and offered only "Go to your own dashboard" -- so the
 * way to follow its own instruction ran through the other organisation's app
 * shell, its user menu, and back here by hand. On a shared device, or for
 * somebody with a second job, that is the whole visit.
 *
 * Same route the shell's own sign-out calls. The reload afterwards is a full
 * one on purpose: the door is a server component that read the session
 * cookie this just revoked, and it has to read again to show the form.
 */
export function SignOutHere({ slug }: { slug: string }) {
  const [leaving, setLeaving] = useState(false);

  async function signOut() {
    setLeaving(true);
    // A failed call still clears nothing server-side, and the reload then
    // shows this same screen again -- which is the honest outcome. The route
    // answers where to go next: a superadmin on a support visit is sent back
    // to the console, because ending the visit leaves them signed in as
    // themselves and this door would only bounce them there anyway.
    const answer = await fetch("/api/auth/logout", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ redirectTo?: string }>) : null))
      .catch(() => null);
    window.location.replace(
      answer?.redirectTo && answer.redirectTo !== "/login" ? answer.redirectTo : `/o/${slug}`,
    );
  }

  return (
    <Button type="button" onClick={() => void signOut()} loading={leaving}>
      {leaving ? null : <LogOut className="size-4" aria-hidden />}
      Sign out and use this page
    </Button>
  );
}
