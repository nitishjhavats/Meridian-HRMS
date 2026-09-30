"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input, Select } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";

interface OrganizationChoice {
  id: string;
  name: string;
}

/**
 * `tenant` is set when this form is rendered on an organisation's own entry
 * URL. It narrows the candidate set so somebody whose email exists in two
 * organisations is not asked which one they meant on the door that already
 * says. It cannot select an organisation the password does not authenticate
 * into — the server verifies against every candidate first, and this is only
 * a filter over that set.
 */
export function LoginForm({
  tenant,
}: {
  tenant?: { id: string; slug: string } | null;
  /**
   * Whether to offer "create an organisation".
   *
   * Off unless the caller says otherwise, for two reasons: with sign-up closed
   * the link lands on a page saying it is closed, and on a tenant's own door
   * an employee of that company is not creating an organisation at all.
   */
} = {}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationId, setOrganizationId] = useState(tenant?.id ?? "");
  const [organizations, setOrganizations] = useState<OrganizationChoice[] | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * The second factor, asked for only once the password has been proven.
   *
   * The API has answered `300 { needsSecondFactor }` since two-factor was
   * built, and this form treated every non-OK status as a failure -- so anybody
   * who switched two-factor on could never sign in again. Nobody on the live
   * instance has yet, which is the only reason it was not an outage.
   */
  const [needsCode, setNeedsCode] = useState(false);
  const [totp, setTotp] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(organizationId ? { organizationId } : {}),
          ...(totp.trim() ? { totp: totp.trim() } : {}),
        }),
      });

      const payload = await response.json();

      // The same email exists in more than one organisation; the password has
      // already been verified, so it is safe to name them.
      if (response.status === 300 && payload.needsOrganization) {
        setOrganizations(payload.organizations as OrganizationChoice[]);
        setOrganizationId(payload.organizations?.[0]?.id ?? "");
        setError(null);
        return;
      }

      if (response.status === 300 && payload.needsSecondFactor) {
        setNeedsCode(true);
        setError(null);
        return;
      }

      if (!response.ok) {
        setError(payload?.error?.message ?? "We could not sign you in. Please try again.");
        return;
      }

      // Back to where the session died, when it died somewhere. Only a path on
      // this site is honoured -- a full URL in `next` would make the login
      // page a redirector for anybody who could get somebody to click a link.
      // A backslash counts as a slash to the URL parser, so `/\evil.com`
      // would leave the site; only a plain same-site path is followed.
      const next = new URLSearchParams(window.location.search).get("next");
      const safeNext = next && /^\/(?![\/\\])/.test(next) && !next.includes("://") ? next : null;
      router.push(payload.mustChangePassword ? "/change-password" : (safeNext ?? payload.redirectTo));
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {organizations ? (
        <Alert tone="info" title="Choose your organisation">
          This email is registered with more than one organisation.
        </Alert>
      ) : null}

      <Field label="Work email" htmlFor="email" required>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setOrganizations(null);
            // Back to the door's own filter, not to nothing: clearing it here
            // put the "choose your organisation" picker on a page that
            // already names the organisation, from the first keystroke.
            setOrganizationId(tenant?.id ?? "");
          }}
          placeholder="you@company.com"
        />
      </Field>

      <Field label="Password" htmlFor="password" required>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>

      {needsCode ? (
        <Field
          label="Code from your authenticator app"
          htmlFor="totp"
          required
          hint="Six digits from the app, or one of the recovery codes you were shown when you set it up."
        >
          <Input
            id="totp"
            name="totp"
            // Not a numeric keyboard: a recovery code is hex with a dash.
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            required
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            placeholder="123456"
            className="tabular text-center font-mono text-lg tracking-[0.2em]"
          />
        </Field>
      ) : null}

      {organizations ? (
        <Field label="Organisation" htmlFor="organizationId" required>
          <Select
            id="organizationId"
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
            required
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={loading}
        disabled={needsCode && totp.trim().length < 6}
      >
        {!loading ? <LogIn className="size-4" aria-hidden /> : null}
        {needsCode ? "Verify and sign in" : "Sign in"}
      </Button>

      <div className="space-y-2 text-center">
        <Link
          href={tenant ? `/o/${tenant.slug}/forgot-password` : "/forgot-password"}
          className="block text-sm text-primary underline-offset-4 hover:underline"
        >
          Forgot your password?
        </Link>
        {/* An office device signs in here like anybody else and is sent
            straight to the kiosk screen. Nobody knew that, because nothing
            said it. */}
        <p className="text-xs text-muted-foreground">
          Setting up a shared office screen? Sign in with the device account your administrator
          made, and it opens straight into attendance.
        </p>

        {/* Never on a tenant's own door: `/o/<slug>` belongs to that customer,
            and inviting their staff to start a competing organisation on it is
            not Broadmate's to do. On the main sign-in page it shows whether or
            not sign-up is open, because `/signup` explains the invitation route
            and how to reach us -- which beats a link that is simply not there. */}
        {tenant ? null : (
          <p className="text-sm text-muted-foreground">
            New here?{" "}
            <Link
              href="/signup"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Create an organisation
            </Link>
          </p>
        )}
      </div>
    </form>
  );
}
