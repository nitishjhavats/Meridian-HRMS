"use client";

import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { copyText } from "@/lib/client/clipboard";

/**
 * A credential, shown once.
 *
 * There is no email in this product by design, so a new password reaches its
 * owner because a person hands it over. That makes this panel the only moment
 * the plaintext exists anywhere: nothing stores it, and the next best thing
 * after losing it is issuing a new one, which is audited.
 *
 * It carries the sign-in link as well as the password, because "go to
 * hrms.broadmate.org" is not an instruction somebody follows on a phone —
 * `/o/<slug>` is the organisation's own door and looks like it.
 */

export interface Credential {
  employeeCode?: string;
  name: string;
  email: string;
  temporaryPassword: string;
  signInUrl: string;
}

export function credentialText(credential: Credential): string {
  return [
    `Sign in: ${credential.signInUrl}`,
    `Email: ${credential.email}`,
    `Temporary password: ${credential.temporaryPassword}`,
    "",
    "You will be asked to choose your own password the first time you sign in.",
  ].join("\n");
}

export function CredentialHandover({
  credential,
  title = "Their sign-in details",
}: {
  credential: Credential;
  title?: string;
}) {
  return (
    <div className="space-y-3">
      <Alert tone="warning" title="Shown once">
        This password is not stored anywhere in readable form. Copy all three now and send them
        together — the link is this organisation&rsquo;s own sign-in page, and it is where these
        details work. If you lose the password you will have to issue a new one.
      </Alert>

      <p className="text-sm font-medium">{title}</p>

      <dl className="space-y-2 text-sm">
        <div className="rounded-md border border-border px-3 py-2">
          <dt className="text-xs text-muted-foreground">Sign in at</dt>
          <dd className="break-all font-mono">{credential.signInUrl}</dd>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <dt className="text-xs text-muted-foreground">Email</dt>
          <dd className="break-all font-mono">{credential.email}</dd>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <dt className="text-xs text-muted-foreground">Temporary password</dt>
          <dd className="font-mono text-base">{credential.temporaryPassword}</dd>
        </div>
      </dl>

      <Button
        variant="outline"
        className="w-full"
        onClick={() => void copyText(credentialText(credential), "Sign-in details copied")}
      >
        <Copy className="size-4" aria-hidden />
        Copy sign-in details
      </Button>
    </div>
  );
}

/**
 * The bulk equivalent: a file, because nobody copies two hundred passwords out
 * of a table by hand.
 *
 * Built in the browser from what the commit returned and never fetched again.
 * The first line is a warning rather than a header row on purpose — this file
 * is a set of working credentials, and whoever opens it should be told so
 * before they read the second line.
 */
export function DownloadCredentialsCsv({
  credentials,
  filename,
}: {
  credentials: Credential[];
  filename: string;
}) {
  function download() {
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      ["# These are working passwords. Hand them over, then delete this file."],
      ["Name", "Employee code", "Sign in at", "Email", "Temporary password"],
      ...credentials.map((c) => [
        c.name,
        c.employeeCode ?? "",
        c.signInUrl,
        c.email,
        c.temporaryPassword,
      ]),
    ];
    const csv = rows.map((row) => row.map((cell) => escape(String(cell))).join(",")).join("\r\n");

    // A BOM so Excel opens it as UTF-8 rather than mangling any non-ASCII name.
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * The same list, into the clipboard.
   *
   * A download is the right primary action for two hundred people, and it was
   * also the *only* one -- so a download that silently failed, or a device that
   * puts files somewhere the person cannot find, lost every one of those
   * passwords for good. Copying is the recovery path, and for the common case
   * of three or four new joiners it is the faster one.
   */
  function copyAll() {
    const block = credentials
      .map((c) =>
        [
          c.name + (c.employeeCode ? ` (${c.employeeCode})` : ""),
          `  Sign in: ${c.signInUrl}`,
          `  Email: ${c.email}`,
          `  Temporary password: ${c.temporaryPassword}`,
        ].join("\n"),
      )
      .join("\n\n");

    void copyText(
      `${block}

Each person is asked to choose their own password at first sign-in.`,
      `${credentials.length} sign-in details copied`,
    );
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" className="w-full" onClick={download}>
        <Download className="size-4" aria-hidden />
        Download {credentials.length} sign-in {credentials.length === 1 ? "detail" : "details"} (CSV)
      </Button>
      <Button variant="ghost" className="w-full" onClick={copyAll}>
        <Copy className="size-4" aria-hidden />
        Copy them instead
      </Button>
    </div>
  );
}
