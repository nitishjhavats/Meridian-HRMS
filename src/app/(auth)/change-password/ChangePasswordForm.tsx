"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { checkPassword } from "@/domain/password";

/**
 * Two passwords: the one you were given, and the one you choose.
 *
 * The old password is asked for even when the change is forced. Being signed in
 * proves possession of a browser, not of the account — and the whole reason this
 * screen exists is that the first password was handed over by somebody else.
 */

const STRENGTH_LABEL = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;

export function ChangePasswordForm({
  forced,
  email,
  returnTo,
  signOutTo,
}: {
  forced: boolean;
  email: string;
  /** Where "Not now -- sign out" lands: the organisation's own door when there is one. */
  signOutTo: string;
  returnTo: string;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  const strength = checkPassword(next);
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready = current.length > 0 && strength.ok && !mismatch && confirm.length > 0;

  /**
   * The way out that does not go through choosing a password.
   *
   * Forced, this screen hides Cancel -- rightly, the one-time password is not
   * a password -- but it offered no sign-out either, and `/login` bounced a
   * signed-in session straight back here through the app layout. Somebody who
   * signed in with a temporary password on the wrong device, or an admin
   * trying a new login on their own machine, was held until they either chose
   * a password they did not want or cleared their cookies.
   *
   * A full navigation afterwards, not the router: the login page is a server
   * component that read the session cookie this just revoked.
   */
  async function signOut() {
    setLeaving(true);
    // The route says where next when it knows better (a support visit ends
    // at the console); otherwise the organisation's door, so the next person
    // on a shared phone sees the address they were handed, not the plain one.
    const answer = await fetch("/api/auth/logout", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ redirectTo?: string }>) : null))
      .catch(() => null);
    window.location.replace(
      answer?.redirectTo && answer.redirectTo !== "/login" ? answer.redirectTo : signOutTo,
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!ready) return;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { otherSessionsSignedOut?: number; error?: { message?: string } }
        | null;

      if (!response.ok) {
        setError(payload?.error?.message ?? "That did not work. Try again in a moment.");
        return;
      }

      setDone(payload?.otherSessionsSignedOut ?? 0);
      router.refresh();
      setTimeout(() => router.replace(returnTo), 1200);
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done !== null) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your password has been changed">
          {done > 0
            ? `${done} other signed-in device${done === 1 ? " was" : "s were"} signed out. Taking you in…`
            : "Taking you in…"}
        </Alert>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {forced ? "Choose your own password" : "Change your password"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{email}</span>.
        </p>
      </div>

      {forced ? (
        <Alert tone="info" title="One more step">
          You are signed in with a password somebody else generated for you. Choose your own
          before you carry on — nobody else will know it, and it cannot be looked up.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Current password" htmlFor="current" required>
        <Input
          id="current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </Field>

      <Field
        label="New password"
        htmlFor="next"
        required
        error={touched && next.length > 0 && !strength.ok ? strength.problems[0] : undefined}
        hint={next ? STRENGTH_LABEL[strength.score] : "At least 12 characters."}
      >
        <div className="relative">
          <Input
            id="next"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onBlur={() => setTouched(true)}
            className="pr-10"
            required
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        </div>
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="confirm"
        required
        error={mismatch ? "The two passwords do not match." : undefined}
      >
        <Input
          id="confirm"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </Field>

      <p className="text-xs text-muted-foreground">
        Every other device you are signed in on will be signed out.
      </p>

      <Button type="submit" className="w-full" loading={loading} disabled={loading || !ready}>
        Change password
      </Button>

      {!forced ? (
        <Button asChild variant="ghost" className="w-full">
          <Link href={returnTo}>Cancel</Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          loading={leaving}
          disabled={loading}
          onClick={() => void signOut()}
        >
          Not now &mdash; sign out
        </Button>
      )}
    </form>
  );
}
