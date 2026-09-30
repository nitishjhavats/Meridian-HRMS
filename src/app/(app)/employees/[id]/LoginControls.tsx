"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { EMPLOYEE_LOGIN_ROLE_LABELS } from "@/domain/employees/loginRoles";
import { CredentialHandover, type Credential } from "@/components/auth/CredentialHandover";

/**
 * Whether this person can get in, and what to do about it.
 *
 * Two situations, one control. Somebody imported before logins existed — or
 * added deliberately without one — has no account at all and needs one made.
 * Somebody who has lost their password needs a new one, and the
 * superadmin-released reset code at `/forgot-password` was never going to be
 * the answer for them: it only ever replied to owners and administrators.
 */


export function LoginControls({
  employeeId,
  name,
  hasLogin,
  hasEmail,
  assignableRoles,
}: {
  employeeId: string;
  name: string;
  hasLogin: boolean;
  hasEmail: boolean;
  /**
   * The roles this caller may hand out, worked out on the server from the
   * same rank rule `createLoginForEmployee` applies. The picker used to offer
   * the whole list, so an HR Manager could choose "HR" or "Administrator" and
   * learn on submit that they could not.
   */
  assignableRoles: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const roles = EMPLOYEE_LOGIN_ROLE_LABELS.filter((r) => assignableRoles.includes(r.value));
  const [role, setRole] = useState<string>(roles[0]?.value ?? "TEAM_MEMBER");
  const [credential, setCredential] = useState<Credential | null>(null);

  async function create() {
    setBusy(true);
    const result = await mutate<{ credential: Credential }>(
      () =>
        api(`/api/employees/${employeeId}/login`, { method: "POST", body: { role } }),
      { success: `${name} can sign in now.`, error: "No login was created" },
    );
    setBusy(false);
    if (result) {
      setAsking(false);
      setCredential(result.credential);
      router.refresh();
    }
  }

  async function reset() {
    setBusy(true);
    const result = await mutate<{ credential: Credential }>(
      () => api(`/api/employees/${employeeId}/password`, { method: "POST" }),
      { success: "A new password was issued.", error: "Nothing was changed" },
    );
    setBusy(false);
    if (result) {
      setCredential(result.credential);
      router.refresh();
    }
  }

  return (
    <>
      {hasLogin ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reset()}>
          <KeyRound className="size-4" aria-hidden />
          Reset password
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !hasEmail || roles.length === 0}
          title={
            !hasEmail
              ? "Add a work email first."
              : roles.length === 0
                ? "Your role cannot hand out a login."
                : undefined
          }
          onClick={() => setAsking(true)}
        >
          <UserPlus className="size-4" aria-hidden />
          Create a login
        </Button>
      )}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Give {name} a login</DialogTitle>
            <DialogDescription>
              They choose their own password the first time they sign in.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="What they may do" htmlFor="newLoginRole">
              <Select id="newLoginRole" value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button loading={busy} disabled={busy} onClick={() => void create()}>
              Create the login
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={credential !== null} onOpenChange={(o) => !o && setCredential(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{name}&rsquo;s sign-in details</DialogTitle>
            <DialogDescription>Pass these to them directly.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {credential ? <CredentialHandover credential={credential} /> : null}
            <Alert tone="info" title="Every other device was signed out">
              Anyone still signed in as {name} — including whoever may have had the old password —
              has been signed out.
            </Alert>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
