"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Download, Upload } from "lucide-react";
import { EMPLOYEE_LOGIN_ROLE_LABELS } from "@/domain/employees/loginRoles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  DownloadCredentialsCsv,
  type Credential,
} from "@/components/auth/CredentialHandover";

/**
 * Loading a spreadsheet of employees.
 *
 * Nothing is written until the second button. The first upload only asks the
 * server what it makes of the file, and that verdict is what fills this screen —
 * row by row, with the spreadsheet's own line numbers, because "row 47" is what
 * somebody can act on and "one of your rows is invalid" is not.
 *
 * The file is uploaded twice, once to preview and once to commit. That is the
 * design: the server rebuilds its decision from the bytes rather than trusting
 * a list of rows this component claims are fine.
 */

interface ImportRow {
  line: number;
  employeeCode: string;
  name: string;
  errors: string[];
}

/** Every reference list the server sends. Three of the five were declared and one rendered. */
interface Known {
  departments: string[];
  designations: string[];
  workLocations: string[];
  shifts: string[];
  weeklyOffPatterns: string[];
}

interface ColumnGuide {
  key: string;
  label: string;
  required: boolean;
  hint: string | null;
  values: string[] | null;
}

interface Preview {
  rows: ImportRow[];
  readyCount: number;
  errorCount: number;
  unknownColumns: string[];
  missingColumns: string[];
  blocked?: string;
  seatsRemaining: number | null;
  known: Known;
}

/** Which reference list belongs to which column, for the guide. */
const REFERENCE_OF: Record<string, keyof Known> = {
  department: "departments",
  designation: "designations",
  worklocation: "workLocations",
  shift: "shifts",
  weeklyoffpattern: "weeklyOffPatterns",
};

export function ImportEmployees() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createLogins, setCreateLogins] = useState(false);
  const [loginRole, setLoginRole] = useState("TEAM_MEMBER");
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [guide, setGuide] = useState<{ columns: ColumnGuide[]; known: Known } | null>(null);
  const [showColumns, setShowColumns] = useState(false);

  // Fetched when the dialog opens, not on the page, because the page renders
  // this for every administrator and most of them are not importing anything.
  useEffect(() => {
    if (!open || guide) return;
    let cancelled = false;
    void fetch("/api/employees/import")
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (!cancelled && payload) setGuide(payload as { columns: ColumnGuide[]; known: Known });
      })
      .catch(() => {
        // The guide is help, not a gate. A failed fetch leaves the screen as it
        // was rather than blocking somebody from importing a file they already
        // know the shape of.
      });
    return () => {
      cancelled = true;
    };
  }, [open, guide]);

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
    setCreateLogins(false);
    setLoginRole("TEAM_MEMBER");
    if (input.current) input.current.value = "";
  }

  async function send(commit: boolean, skipRowsWithErrors = false) {
    if (!file) return null;
    const body = new FormData();
    body.set("file", file);
    if (commit) body.set("commit", "true");
    if (skipRowsWithErrors) body.set("skipRowsWithErrors", "true");
    if (commit && createLogins) {
      body.set("createLogins", "true");
      // The service has honoured this since logins were added and no client
      // ever sent it, so every imported login was a Team Member whatever the
      // spreadsheet said. A row naming its own Login Role still wins.
      body.set("loginRole", loginRole);
    }

    const response = await fetch("/api/employees/import", { method: "POST", body });
    const payload = (await response.json().catch(() => null)) as
      | (Preview & {
          created?: number;
          skipped?: number;
          credentials?: Credential[];
          salariesSet?: number;
          managersLinked?: number;
          warnings?: string[];
        })
      | { error?: { message?: string } }
      | null;

    if (!response.ok) {
      const message =
        (payload as { error?: { message?: string } } | null)?.error?.message ??
        "That file could not be read.";
      setError(message);
      return null;
    }
    return payload as Preview & {
      created?: number;
      skipped?: number;
      credentials?: Credential[];
      salariesSet?: number;
      managersLinked?: number;
      warnings?: string[];
    };
  }

  async function onChoose(chosen: File | null) {
    setFile(chosen);
    setPreview(null);
    setError(null);
    if (!chosen) return;

    setBusy(true);
    const body = new FormData();
    body.set("file", chosen);
    const response = await fetch("/api/employees/import", { method: "POST", body });
    const payload = (await response.json().catch(() => null)) as never;
    setBusy(false);

    if (!response.ok) {
      setError(
        (payload as { error?: { message?: string } })?.error?.message ??
          "That file could not be read.",
      );
      return;
    }
    setPreview(payload as Preview);
  }

  async function commit(skipRowsWithErrors: boolean) {
    setBusy(true);
    setError(null);
    const result = await send(true, skipRowsWithErrors);
    setBusy(false);
    if (!result) return;

    const extras = [
      result.salariesSet ? `${result.salariesSet} with pay` : null,
      result.managersLinked ? `${result.managersLinked} with a manager` : null,
    ].filter(Boolean);
    toast.success(
      [
        result.skipped
          ? `${result.created} added, ${result.skipped} left for you to fix.`
          : `${result.created} employees added.`,
        extras.length > 0 ? `${extras.join(", ")}.` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
    // Anything that could not be done after the rows landed. The people are in;
    // this says what still needs a hand, and a toast is the wrong place for it
    // because it is gone before it has been read.
    for (const warning of result.warnings ?? []) toast.error(warning, { duration: 12000 });
    setOpen(false);
    // Held before the reset, because this is the only time these passwords will
    // ever be readable.
    const issued = result.credentials ?? [];
    reset();
    if (issued.length > 0) setCredentials(issued);
    router.refresh();
  }

  const ready = preview?.readyCount ?? 0;
  const bad = preview?.errorCount ?? 0;
  const canCommit = !!preview && !preview.blocked && ready > 0 && !busy;

  return (
    <>
      <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Upload className="size-4" aria-hidden />
          Import
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import employees</DialogTitle>
          <DialogDescription>
            A CSV. In Excel, Save As &rarr; CSV UTF-8; in Google Sheets, File &rarr; Download
            &rarr; Comma-separated values.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/api/employees/import/template" download>
                <Download className="size-4" aria-hidden />
                Download the template
              </a>
            </Button>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-border"
              onChange={(e) => void onChoose(e.target.files?.[0] ?? null)}
            />
          </div>

          {guide ? (
            <div className="rounded-lg border border-border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
                aria-expanded={showColumns}
                onClick={() => setShowColumns((v) => !v)}
              >
                <span>
                  What goes in each column
                  <span className="ml-2 font-normal text-muted-foreground">
                    {guide.columns.length} columns, {guide.columns.filter((c) => c.required).length}{" "}
                    required
                  </span>
                </span>
                <span aria-hidden className="text-muted-foreground">
                  {showColumns ? "\u2212" : "+"}
                </span>
              </button>

              {showColumns ? (
                <div className="max-h-72 overflow-y-auto border-t border-border">
                  <dl className="divide-y divide-border">
                    {guide.columns.map((column) => {
                      const reference = REFERENCE_OF[column.key];
                      const names = reference ? guide.known[reference] : null;
                      return (
                        <div key={column.key} className="px-3 py-2">
                          <dt className="flex items-center gap-2 text-sm font-medium">
                            {column.label}
                            {column.required ? (
                              <Badge tone="danger">required</Badge>
                            ) : null}
                          </dt>
                          <dd className="mt-0.5 text-xs text-muted-foreground">
                            {/* The org's own names, not the word "Must already
                                exist" — which is true and impossible to act on. */}
                            {names
                              ? names.length > 0
                                ? names.join(", ")
                                : "You have none of these yet. Leave the column blank, or create them first."
                              : (column.values ?? []).length > 0
                                ? (column.values ?? []).join(", ")
                                : (column.hint ?? "Free text.")}
                          </dd>
                          {names || (column.values ?? []).length > 0 ? (
                            column.hint ? (
                              <dd className="mt-0.5 text-xs text-muted-foreground/80">
                                {column.hint}
                              </dd>
                            ) : null
                          ) : null}
                        </div>
                      );
                    })}
                  </dl>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <Alert tone="danger">{error}</Alert> : null}

          {busy && !preview ? (
            <p className="text-sm text-muted-foreground">Reading the file…</p>
          ) : null}

          {preview ? (
            <>
              {preview.blocked ? (
                <Alert tone="danger" title="This file cannot be imported">
                  {preview.blocked}
                </Alert>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="success">{ready} ready</Badge>
                  {bad > 0 ? <Badge tone="danger">{bad} with problems</Badge> : null}
                  {preview.seatsRemaining !== null ? (
                    <span className="text-muted-foreground">
                      {preview.seatsRemaining} seat{preview.seatsRemaining === 1 ? "" : "s"} free
                    </span>
                  ) : null}
                </div>
              )}

              {preview.unknownColumns.length > 0 ? (
                <Alert tone="info" title="Some columns will be ignored">
                  {preview.unknownColumns.join(", ")} — nothing in the file is changed, these
                  simply are not fields on an employee.
                </Alert>
              ) : null}

              {bad > 0 ? (
                <div className="overflow-hidden rounded-lg border border-border">
                  <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium">
                    Rows that need attention
                  </p>
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                    {preview.rows
                      .filter((r) => r.errors.length > 0)
                      .map((row) => (
                        <li key={row.line} className="px-3 py-2 text-sm">
                          <p className="flex items-center gap-2 font-medium">
                            <CircleAlert className="size-4 shrink-0 text-danger-text" aria-hidden />
                            Line {row.line}
                            <span className="font-normal text-muted-foreground">
                              {row.employeeCode || row.name}
                            </span>
                          </p>
                          <ul className="ml-6 mt-0.5 list-disc space-y-0.5 text-xs text-danger-text">
                            {row.errors.map((message) => (
                              <li key={message}>{message}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}

              {bad > 0 ? (
                <p className="text-xs text-muted-foreground">
                  The names a cell may use are listed under “What goes in each column” above.
                </p>
              ) : null}
            </>
          ) : null}
        </DialogBody>

        {preview && !preview.blocked && ready > 0 ? (
          <div className="border-t border-border px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Give them logins too</p>
                <p className="text-xs text-muted-foreground">
                  One-time passwords for every row that has an email address, downloaded as a CSV
                  when the import finishes. Rows without an email are still imported, just without
                  a login.
                </p>
              </div>
              <Switch
                checked={createLogins}
                disabled={busy}
                aria-label="Give them logins too"
                onCheckedChange={setCreateLogins}
              />
            </div>

            {createLogins ? (
              <div className="mt-3">
                <label
                  htmlFor="import-login-role"
                  className="text-xs font-medium text-muted-foreground"
                >
                  What they can do
                </label>
                <select
                  id="import-login-role"
                  value={loginRole}
                  disabled={busy}
                  onChange={(e) => setLoginRole(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {EMPLOYEE_LOGIN_ROLE_LABELS.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  A row with its own Login Role uses that instead.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {preview && !preview.blocked && bad > 0 ? (
            <Button variant="secondary" loading={busy} disabled={ready === 0} onClick={() => void commit(true)}>
              Import the {ready} that are ready
            </Button>
          ) : null}
          <Button loading={busy} disabled={!canCommit || bad > 0} onClick={() => void commit(false)}>
            {ready > 0 ? `Import ${ready}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      {/* Its own root: the import dialog has already closed by the time this
          opens, and these passwords exist nowhere else. */}
      <Dialog open={credentials !== null} onOpenChange={(o) => !o && setCredentials(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {credentials?.length} {credentials?.length === 1 ? "person" : "people"} can sign in
            </DialogTitle>
            <DialogDescription>
              Download the file, hand the details out, then delete it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Alert tone="warning" title="Shown once">
              These passwords are not stored anywhere in readable form. If you close this without
              downloading, you will have to reset each person individually.
            </Alert>
            {credentials ? (
              <DownloadCredentialsCsv credentials={credentials} filename="sign-in-details.csv" />
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
