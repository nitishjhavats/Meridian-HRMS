"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, Copy, Eye, EyeOff, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { checkPassword } from "@/domain/password";
import { copyText } from "@/lib/client/clipboard";

/**
 * Creating an organisation.
 *
 * The password is checked against the same rules the server applies, as the
 * person types, so nobody fills in four fields only to be told at the end that
 * their password needs a number.
 */

const STRENGTH_LABEL = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;

export function SignUpForm({ trialDays }: { trialDays: number }) {
  const router = useRouter();
  const [form, setForm] = useState({
    organizationName: "",
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [touchedPassword, setTouchedPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Recorded server-side with the version, and the service refuses without it.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [created, setCreated] = useState<{ signInUrl: string; email: string } | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const strength = checkPassword(form.password);
  const ready =
    form.organizationName.trim().length >= 2 &&
    form.name.trim().length >= 2 &&
    form.email.includes("@") &&
    strength.ok &&
    acceptedTerms;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationName: form.organizationName.trim(),
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          acceptedTerms,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error?.message ?? "We could not create your organisation. Please try again.");
        return;
      }

      /**
       * Their organisation's link, before the dashboard.
       *
       * They are already signed in -- this is not a credential handover, and
       * their password is one they chose a moment ago and is not shown. What
       * they do not have is the address every employee they are about to add
       * will need, and this is the only moment anybody thinks to give it to
       * them.
       */
      if (payload.signInUrl) {
        setCreated({ signInUrl: payload.signInUrl, email: payload.email ?? form.email.trim() });
        return;
      }

      router.push(payload.redirectTo ?? "/dashboard");
      router.refresh();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Your organisation is ready">
          This is its own sign-in page. Copy the link now &mdash; it is what you give every
          employee you add, and signing in there shows them your organisation rather than ours.
        </Alert>

        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">Your organisation signs in at</p>
          <p className="break-all font-mono text-sm">{created.signInUrl}</p>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">Your own sign-in</p>
          <p className="break-all font-mono text-sm">{created.email}</p>
        </div>

        {/* Written for the employee it is forwarded to, not the owner
            pressing the button. The alert above says this is what they give
            every employee; the copied text used to name the owner's own
            email and tell the reader to "use the password you were given",
            which described nobody -- the owner had just chosen theirs, and
            the employees did not exist yet. The owner's email stays on the
            screen above, where it is theirs to read. */}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() =>
            void copyText(
              `Sign in here: ${created.signInUrl}

Use the work email and the temporary password your administrator gives you. You will be asked to choose your own password the first time you sign in.`,
              "Sign-in link copied",
            )
          }
        >
          <Copy className="size-4" aria-hidden />
          Copy the sign-in link
        </Button>

        <Button
          type="button"
          className="w-full"
          onClick={() => {
            router.push("/dashboard");
            router.refresh();
          }}
        >
          Continue to your dashboard
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label="Organisation name" htmlFor="organizationName" required>
        <div className="relative">
          <Building2
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="organizationName"
            className="pl-9"
            value={form.organizationName}
            autoComplete="organization"
            placeholder="Acme Technologies"
            onChange={(e) => set("organizationName", e.target.value)}
            required
          />
        </div>
      </Field>

      <Field label="Your name" htmlFor="name" required>
        <Input
          id="name"
          value={form.name}
          autoComplete="name"
          onChange={(e) => set("name", e.target.value)}
          required
        />
      </Field>

      <Field
        label="Work email"
        htmlFor="email"
        required
        hint="This becomes your sign-in and the Owner account."
      >
        <Input
          id="email"
          type="email"
          value={form.email}
          autoComplete="email"
          onChange={(e) => set("email", e.target.value)}
          required
        />
      </Field>

      <Field label="Phone" htmlFor="phone" hint="Optional.">
        <Input
          id="phone"
          type="tel"
          value={form.phone}
          autoComplete="tel"
          onChange={(e) => set("phone", e.target.value)}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        error={
          touchedPassword && form.password !== "" && !strength.ok
            ? strength.problems[0]
            : undefined
        }
      >
        <div className="flex gap-2">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            value={form.password}
            autoComplete="new-password"
            onChange={(e) => set("password", e.target.value)}
            onBlur={() => setTouchedPassword(true)}
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={showPassword ? "Hide password" : "Show password"}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </Field>

      {form.password ? (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
            <div
              className={
                strength.score >= 3 ? "h-full bg-success" : strength.score >= 2 ? "h-full bg-warning" : "h-full bg-danger"
              }
              style={{ width: `${((strength.score + 1) / 5) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{STRENGTH_LABEL[strength.score]}</span>
        </div>
      ) : null}

      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
        <input
          type="checkbox"
          checked={acceptedTerms}
          onChange={(e) => setAcceptedTerms(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        />
        <span className="text-muted-foreground">
          I have read and accept the{" "}
          <Link
            href="/legal/terms"
            target="_blank"
            className="font-medium text-foreground underline underline-offset-2"
          >
            terms of service
          </Link>{" "}
          and the{" "}
          <Link
            href="/legal/privacy"
            target="_blank"
            className="font-medium text-foreground underline underline-offset-2"
          >
            privacy policy
          </Link>
          . I understand that my organisation is responsible for telling its employees what is
          collected about them.
        </span>
      </label>

      <Button type="submit" className="w-full" loading={loading} disabled={!ready}>
        <UserPlus className="size-4" aria-hidden />
        Create my organisation
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        You get a {trialDays}-day trial. No card is asked for, and nothing is charged until you
        choose to buy seats.
      </p>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </form>
  );
}
