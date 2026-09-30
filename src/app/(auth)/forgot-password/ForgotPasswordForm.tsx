"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, KeyRound, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { checkPassword } from "@/domain/password";
import { type ResetPath, signInHrefFor } from "./signInHref";

/**
 * Resetting a forgotten password.
 *
 * There is no email in this product, by design — the code is released by the
 * platform owner after they have satisfied themselves the request is genuine,
 * and handed over out of band. So this is two steps with a wait in between,
 * and the screen says so rather than leaving somebody watching an inbox that
 * will never receive anything.
 *
 * The first step's response is deliberately identical whether or not the
 * account exists. Saying "no such account" would turn this form into a way to
 * find out who works where.
 *
 * That same silence is why the form asks who the account is for. A code is
 * only ever minted for the organisation's Owner and Admins; everybody else is
 * reset by HR or an Admin from their employee profile. The server will not say
 * which applies, so before this asked, every employee was told a code was
 * waiting, typed whatever they were given, and was told it was not valid —
 * with the real route never mentioned.
 */

const STRENGTH_LABEL = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;

export function ForgotPasswordForm() {
  const router = useRouter();
  const signInHref = signInHrefFor(usePathname());
  const [step, setStep] = useState<"request" | "reset">("request");
  const [path, setPath] = useState<ResetPath | null>(null);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const strength = checkPassword(password);

  async function request(event: React.FormEvent) {
    event.preventDefault();
    // Enter in the email box submits the form even with no button showing.
    if (path !== "code") return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "That did not work. Try again in a moment.");
        return;
      }
      setStep("reset");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function reset(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim(), newPassword: password }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "That code was not accepted.");
        return;
      }
      setDone(true);
      setTimeout(() => router.push(signInHref), 2500);
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your password has been changed">
          Every other session was signed out. Taking you to the sign-in page…
        </Alert>
        <Button asChild className="w-full">
          <Link href={signInHref}>Sign in</Link>
        </Button>
      </div>
    );
  }

  if (step === "reset") {
    return (
      <form onSubmit={reset} className="space-y-4">
        <Alert tone="info" title="Ask for your code">
          If <span className="font-medium">{email}</span> is an Owner or Admin account, a
          verification code is now waiting to be released. Contact your administrator to get it —
          it is handed over directly, never emailed. No code is issued for any other role: if that
          is you, go back and choose the other option.
        </Alert>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Field label="Verification code" htmlFor="otp" required>
          <Input
            id="otp"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="tabular tracking-[0.3em]"
            required
          />
        </Field>

        <Field
          label="New password"
          htmlFor="password"
          required
          error={touched && !strength.ok ? strength.problems[0] : undefined}
          hint={password ? STRENGTH_LABEL[strength.score] : "At least 12 characters."}
        >
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched(true)}
              autoComplete="new-password"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <Button
          type="submit"
          className="w-full"
          loading={loading}
          disabled={!otp.trim() || !strength.ok}
        >
          <KeyRound className="size-4" aria-hidden />
          Set the new password
        </Button>

        <button
          type="button"
          onClick={() => {
            setStep("request");
            setError(null);
          }}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={request} className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field
        label="Work email"
        htmlFor="email"
        required
        hint="The address your organisation registered for you."
      >
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          placeholder="you@company.com"
          required
          autoFocus
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who is this account for?</legend>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 text-sm has-[:checked]:border-primary">
          <input
            type="radio"
            name="path"
            className="mt-0.5"
            checked={path === "code"}
            onChange={() => setPath("code")}
          />
          <span>
            <span className="block font-medium">The organisation&apos;s Owner or an Admin</span>
            <span className="block text-xs text-muted-foreground">
              A reset code is released for you and handed over directly.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 text-sm has-[:checked]:border-primary">
          <input
            type="radio"
            name="path"
            className="mt-0.5"
            checked={path === "hr"}
            onChange={() => setPath("hr")}
          />
          <span>
            <span className="block font-medium">Anyone else</span>
            <span className="block text-xs text-muted-foreground">
              HR, a manager, a team lead, a supervisor or a team member.
            </span>
          </span>
        </label>
      </fieldset>

      {path === "hr" ? (
        // No request is sent: the server would mint nothing for this account
        // and answer as though it had. Saying so here is the whole fix.
        <Alert tone="info" title="Ask HR or an administrator">
          No reset code is issued for your account. Ask HR or an administrator to reset your
          password from your employee profile — they will give you a temporary password. Sign in
          with it and you will be asked to choose a new one.
        </Alert>
      ) : (
        <Button
          type="submit"
          className="w-full"
          loading={loading}
          disabled={!email.trim() || path !== "code"}
        >
          <Mail className="size-4" aria-hidden />
          Request a reset
        </Button>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href={signInHref} className="font-medium text-foreground underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </form>
  );
}
