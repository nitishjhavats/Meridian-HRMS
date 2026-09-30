"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import {
  Check,
  Copy,
  KeyRound,
  Laptop,
  LogOut,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { formatDateTime } from "@/lib/utils";
import type { TwoFactorStatus } from "@/services/auth/twoFactor";
import type { LoginEventRow, SessionRow } from "@/services/auth/sessions";

/**
 * Personal security.
 *
 * Three questions, in the order somebody worried about their account asks them:
 * is a second factor on, what is signed in right now, and has anything tried to
 * sign in as me. The last one includes failures deliberately — a failed attempt
 * from an unfamiliar place is the whole reason to look.
 */

interface EnrolmentStart {
  secret: string;
  uri: string;
  manualEntry: string;
}

export function SecuritySettings({
  status,
  sessions,
  history,
}: {
  status: TwoFactorStatus;
  sessions: SessionRow[];
  history: LoginEventRow[];
}) {
  return (
    <div className="space-y-4">
      <TwoFactorCard status={status} />
      <SessionsCard sessions={sessions} />
      <HistoryCard history={history} />
    </div>
  );
}

// ------------------------------------------------------------- two-factor

function TwoFactorCard({ status }: { status: TwoFactorStatus }) {
  const router = useRouter();
  const [enrolment, setEnrolment] = useState<EnrolmentStart | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Shown exactly once, after enrolment or a regeneration. Held in state rather
  // than fetched, because the server will never send them again.
  const [codes, setCodes] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState<"disable" | "regenerate" | null>(null);

  async function begin() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<EnrolmentStart>("/api/auth/two-factor", { method: "POST", body: { action: "begin" } }),
      { error: "Setup could not be started" },
    );
    setBusy(false);
    if (result) {
      setEnrolment(result);
      setCode("");
    }
  }

  async function confirm() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ enabled: boolean; recoveryCodes: string[] }>("/api/auth/two-factor", {
          method: "POST",
          body: { action: "confirm", code },
        }),
      { success: "Two-factor authentication is on.", error: "That code was not accepted" },
    );
    setBusy(false);
    if (result) {
      setEnrolment(null);
      setCode("");
      setCodes(result.recoveryCodes);
      router.refresh();
    }
  }

  const low = status.enabled && status.recoveryCodesLeft <= 2;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4.5 text-primary" aria-hidden />
              Two-factor authentication
            </CardTitle>
            <Badge tone={status.enabled ? "success" : "warning"}>
              {status.enabled ? "On" : "Off"}
            </Badge>
          </div>
          <CardDescription>
            A six-digit code from an authenticator app, asked for after your password. It means a
            stolen password on its own is not enough to sign in as you.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {status.enabled ? (
            <>
              <p className="text-sm text-muted-foreground">
                On since {formatDateTime(status.enabledAt)}.{" "}
                <span className={low ? "font-medium text-warning-text" : undefined}>
                  {status.recoveryCodesLeft} recovery{" "}
                  {status.recoveryCodesLeft === 1 ? "code" : "codes"} left.
                </span>
              </p>
              {low ? (
                <Alert tone="warning" title="You are running low on recovery codes">
                  These are what get you back in if your phone is lost. Issue a new set now — the
                  old ones stop working the moment you do.
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setPrompt("regenerate")}>
                  <KeyRound className="size-4" aria-hidden />
                  New recovery codes
                </Button>
                <Button variant="danger" size="sm" onClick={() => setPrompt("disable")}>
                  Turn off
                </Button>
              </div>
            </>
          ) : enrolment ? (
            <Enrolment
              enrolment={enrolment}
              code={code}
              onCode={setCode}
              busy={busy}
              onConfirm={confirm}
              onCancel={() => setEnrolment(null)}
            />
          ) : (
            <>
              {status.recommended ? (
                <Alert tone="warning" title="Strongly recommended for your role">
                  Your account can change pay and everybody&rsquo;s data. That makes it worth
                  attacking, and worth a second lock.
                </Alert>
              ) : null}
              <Button size="sm" onClick={begin} loading={busy}>
                <Smartphone className="size-4" aria-hidden />
                Set up
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}

      <PasswordPrompt
        open={prompt !== null}
        title={
          prompt === "disable" ? "Turn off two-factor authentication" : "Issue new recovery codes"
        }
        confirmLabel={prompt === "disable" ? "Turn it off" : "Issue new codes"}
        danger={prompt === "disable"}
        description={
          prompt === "disable"
            ? "Your account will be protected by its password alone. Confirm it is you."
            : "The codes you have now will stop working. Confirm it is you."
        }
        onClose={() => setPrompt(null)}
        onSubmit={async (password) => {
          if (prompt === "disable") {
            const result = await mutate(
              () =>
                api<{ enabled: boolean }>("/api/auth/two-factor", {
                  method: "POST",
                  body: { action: "disable", password },
                }),
              { success: "Two-factor authentication is off.", error: "It was not turned off" },
            );
            if (!result) return false;
            router.refresh();
            return true;
          }

          const result = await mutate(
            () =>
              api<{ recoveryCodes: string[] }>("/api/auth/two-factor", {
                method: "POST",
                body: { action: "regenerate-codes", password },
              }),
            { error: "New codes were not issued" },
          );
          if (!result) return false;
          setCodes(result.recoveryCodes);
          router.refresh();
          return true;
        }}
      />
    </>
  );
}

function Enrolment({
  enrolment,
  code,
  onCode,
  busy,
  onConfirm,
  onCancel,
}: {
  enrolment: EnrolmentStart;
  code: string;
  onCode: (value: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(enrolment.uri, { errorCorrectionLevel: "M", margin: 1, width: 320 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      // A QR that will not draw must not block enrolment: the typed key below
      // reaches exactly the same place.
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enrolment.uri]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
        <div className="mx-auto w-fit rounded-lg border border-border bg-white p-3">
          {qr ? (
            <img
              src={qr}
              alt="QR code for your authenticator app"
              width={180}
              height={180}
              className="size-[180px]"
            />
          ) : (
            <div className="grid size-[180px] place-items-center px-3 text-center text-xs text-gray-500">
              {qrFailed ? "QR unavailable — type the key instead" : "Generating…"}
            </div>
          )}
        </div>

        <ol className="ml-4 list-decimal space-y-3 text-sm">
          <li>
            Open an authenticator app — Google Authenticator, Authy, 1Password, or any other.
          </li>
          <li>
            Scan the code, or type this key in by hand:
            <CopyRow value={enrolment.secret} display={enrolment.manualEntry} label="Key" />
          </li>
          <li>Enter the six digits it shows you.</li>
        </ol>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Field label="Code from the app" htmlFor="totp-code">
            <Input
              id="totp-code"
              value={code}
              onChange={(e) => onCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={7}
              className="tabular tracking-[0.3em]"
            />
          </Field>
        </div>
        <Button
          size="sm"
          onClick={onConfirm}
          loading={busy}
          disabled={code.replace(/\s/g, "").length < 6}
        >
          Turn it on
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The one-time view of the recovery codes.
 *
 * Deliberately a modal that has to be acknowledged: these cannot be shown again,
 * and somebody who scrolls past them loses their way back into the account.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => (!open && saved ? onDone() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Alert tone="warning" title="This is the only time these are shown">
            Each one signs you in once if you lose your phone. Keep them somewhere that is not your
            phone.
          </Alert>
          <ul className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-muted/40 p-3 font-mono text-sm">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                // Only counts as saved if it actually reached the clipboard.
                // Otherwise the download below is the way out — the codes
                // cannot be shown again to somebody who dismissed this.
                if (await copyText(codes.join("\n"), "Recovery codes copied")) setSaved(true);
              }}
            >
              <Copy className="size-4" aria-hidden />
              Copy all
            </Button>
            <Button size="sm" variant="outline" asChild onClick={() => setSaved(true)}>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(codes.join("\n"))}`}
                download="recovery-codes.txt"
              >
                Download
              </a>
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onDone} disabled={!saved}>
            <Check className="size-4" aria-hidden />
            {saved ? "I have saved them" : "Copy or download them first"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyRow({ value, display, label }: { value: string; display: string; label: string }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
      <code className="min-w-0 break-all font-mono text-xs">{display}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void copyText(value, `${label} copied`)}
      >
        <Copy className="size-4" aria-hidden />
        <span className="sr-only">Copy {label.toLowerCase()}</span>
      </Button>
    </div>
  );
}

/** Re-authentication before a change that weakens the account. */
function PasswordPrompt({
  open,
  title,
  description,
  confirmLabel,
  danger,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  function close() {
    setPassword("");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{description}</p>
          <Field label="Your password" htmlFor="confirm-password">
            <Input
              id="confirm-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            disabled={password.length === 0}
            onClick={async () => {
              setBusy(true);
              const ok = await onSubmit(password);
              setBusy(false);
              if (ok) close();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- sessions

function SessionsCard({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const others = sessions.filter((s) => !s.current).length;

  async function revoke(sessionId: string) {
    setBusy(sessionId);
    const result = await mutate(
      () => api("/api/auth/sessions", { method: "POST", body: { action: "revoke", sessionId } }),
      { success: "That device is signed out.", error: "It was not signed out" },
    );
    setBusy(null);
    if (result) router.refresh();
  }

  async function revokeOthers() {
    setBusy("all");
    const result = await mutate(
      () =>
        api<{ revoked: number }>("/api/auth/sessions", {
          method: "POST",
          body: { action: "revoke-others" },
        }),
      { error: "Those devices were not signed out" },
    );
    setBusy(null);
    if (result) {
      toast.success(
        result.revoked === 1
          ? "1 other device signed out."
          : `${result.revoked} other devices signed out.`,
      );
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Laptop className="size-4.5 text-primary" aria-hidden />
            Where you are signed in
          </CardTitle>
          {others > 0 ? (
            <Button size="sm" variant="outline" loading={busy === "all"} onClick={revokeOthers}>
              <LogOut className="size-4" aria-hidden />
              Sign out everywhere else
            </Button>
          ) : null}
        </div>
        <CardDescription>
          Anything you do not recognise, sign it out — then change your password.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-0 sm:px-0">
        <ResponsiveList
          items={sessions}
          head={
            <>
              <TH>Device</TH>
              <TH>Address</TH>
              <TH>Last used</TH>
              <TH>Signed in</TH>
              <TH />
            </>
          }
          row={(s) => (
            <TR key={s.id}>
              <TD>
                <span className="flex items-center gap-2">
                  {s.deviceLabel}
                  {s.current ? <Badge tone="primary">This device</Badge> : null}
                </span>
              </TD>
              <TD className="font-mono text-xs">{s.ipAddress ?? "—"}</TD>
              <TD>{formatDateTime(s.lastSeenAt ?? s.createdAt)}</TD>
              <TD>{formatDateTime(s.createdAt)}</TD>
              <TD className="text-right">
                {s.current ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === s.id}
                    onClick={() => revoke(s.id)}
                  >
                    Sign out
                  </Button>
                )}
              </TD>
            </TR>
          )}
          card={(s) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {s.deviceLabel}
                  {s.current ? <Badge tone="primary">This device</Badge> : null}
                </p>
                {s.current ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === s.id}
                    onClick={() => revoke(s.id)}
                  >
                    Sign out
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Last used {formatDateTime(s.lastSeenAt ?? s.createdAt)}
                {s.ipAddress ? ` · ${s.ipAddress}` : ""}
              </p>
            </div>
          )}
          empty={<EmptyState icon={Laptop} title="No active sessions" />}
        />
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------- history

/** The stored reasons, said in words rather than in enum. */
const REASON: Record<string, string> = {
  OK: "Signed in",
  BAD_PASSWORD: "Wrong password",
  BAD_TOTP: "Wrong two-factor code",
  LOCKED: "Account locked",
  SUSPENDED: "Account suspended",
  NO_SUCH_USER: "No such account",
};

function HistoryCard({ history }: { history: LoginEventRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4.5 text-primary" aria-hidden />
          Recent sign-in attempts
        </CardTitle>
        <CardDescription>
          Failures are listed too. An attempt you did not make is worth acting on.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-0 sm:px-0">
        <ResponsiveList
          items={history}
          head={
            <>
              <TH>When</TH>
              <TH>Outcome</TH>
              <TH>Device</TH>
              <TH>Address</TH>
            </>
          }
          row={(e) => (
            <TR key={e.id}>
              <TD>{formatDateTime(e.createdAt)}</TD>
              <TD>
                <Badge tone={e.success ? "success" : "danger"}>
                  {REASON[e.reason ?? ""] ?? (e.success ? "Signed in" : "Failed")}
                </Badge>
              </TD>
              <TD>{e.deviceLabel}</TD>
              <TD className="font-mono text-xs">{e.ipAddress ?? "—"}</TD>
            </TR>
          )}
          card={(e) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm">{formatDateTime(e.createdAt)}</p>
                <Badge tone={e.success ? "success" : "danger"}>
                  {REASON[e.reason ?? ""] ?? (e.success ? "Signed in" : "Failed")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {e.deviceLabel}
                {e.ipAddress ? ` · ${e.ipAddress}` : ""}
              </p>
            </div>
          )}
          empty={<EmptyState icon={ShieldAlert} title="Nothing recorded yet" />}
        />
      </CardContent>
    </Card>
  );
}
