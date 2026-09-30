"use client";

import { useMemo, useState } from "react";
import { KeyRound, Search, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatRelative } from "@/lib/utils";

/**
 * Pick the person, say why, read the code out.
 *
 * The roster is searched on the client: it is the whole organisation and it is
 * small -- name, code, designation -- so a round trip per keystroke would buy
 * nothing. The code is shown once, large enough to read across a desk, and the
 * list below refreshes so the issuer can see it used.
 */

interface Person {
  id: string;
  name: string;
  code: string;
  designation: string | null;
}

interface Recent {
  id: string;
  employeeName: string;
  employeeCode: string;
  issuedAt: string;
  expiresAt: string;
  usedAt: string | null;
  reason: string | null;
  issuedByName: string | null;
  state: "LIVE" | "USED" | "EXPIRED";
}

const STATE_TONE = { LIVE: "success", USED: "neutral", EXPIRED: "neutral" } as const;

export function PinDesk({
  people,
  initialRecent,
  seesEverybodys,
}: {
  people: Person[];
  initialRecent: Recent[];
  seesEverybodys: boolean;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Person | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ code: string; expiresAt: string; for: Person } | null>(null);
  const [recent, setRecent] = useState<Recent[]>(initialRecent);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people.slice(0, 12);
    return people
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.designation ?? "").toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [people, query]);

  async function refreshRecent() {
    const result = await api<{ pins: Recent[] }>("/api/attendance/pins/recent").catch(() => null);
    if (result) setRecent(result.pins);
  }

  async function issue() {
    if (!chosen) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ code: string; expiresAt: string }>(`/api/employees/${chosen.id}/attendance-pin`, {
          method: "POST",
          body: { reason: reason.trim() || undefined },
        }),
      { error: "A PIN was not issued" },
    );
    setBusy(false);
    if (result) {
      setIssued({ ...result, for: chosen });
      setReason("");
      void refreshRecent();
    }
  }

  const minutesLeft = issued
    ? Math.max(0, Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 60000))
    : 0;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Issue a PIN</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {issued ? (
            <Alert tone="success" title={`Read this to ${issued.for.name.split(" ")[0]}`}>
              <span className="mt-1 block text-center font-mono text-4xl font-semibold tracking-[0.3em]">
                {issued.code}
              </span>
              <span className="mt-2 block text-center">
                Works once, for the next {minutesLeft} minutes &mdash; at the office device, or
                on their own phone to confirm a mark that came out unverified. The mark it
                makes is flagged for review.
              </span>
              <span className="mt-2 flex justify-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIssued(null);
                    setChosen(null);
                    setQuery("");
                  }}
                >
                  Done
                </Button>
              </span>
            </Alert>
          ) : (
            <>
              <Field label="Who is it for?" htmlFor="pinSearch">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    id="pinSearch"
                    className="pl-9"
                    placeholder="Name, code or designation"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setChosen(null);
                    }}
                    autoComplete="off"
                  />
                </div>
              </Field>

              {people.length === 0 ? (
                <EmptyState
                  icon={UserRound}
                  title="Nobody to issue for"
                  description="There are no other active employees in this organisation."
                />
              ) : (
                <ul
                  className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border"
                  aria-label="People"
                >
                  {matches.length === 0 ? (
                    <li className="px-3 py-3 text-sm text-muted-foreground">Nobody matches.</li>
                  ) : (
                    matches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setChosen(p)}
                          aria-pressed={chosen?.id === p.id}
                          className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                            chosen?.id === p.id ? "bg-primary-muted" : "hover:bg-muted"
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {p.code}
                              {p.designation ? ` · ${p.designation}` : ""}
                            </span>
                          </span>
                          {chosen?.id === p.id ? <Badge tone="info">Chosen</Badge> : null}
                        </button>
                      </li>
                    ))
                  )}
                  {!query && people.length > matches.length ? (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      Showing {matches.length} of {people.length}. Type to find somebody else.
                    </li>
                  ) : null}
                </ul>
              )}

              <Field label="Reason (optional)" htmlFor="pinReason" hint="Kept with the PIN in the audit log.">
                <Input
                  id="pinReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Bandage over one eye today"
                  maxLength={120}
                />
              </Field>

              <Button size="lg" className="w-full sm:w-auto" loading={busy} disabled={!chosen} onClick={() => void issue()}>
                <KeyRound className="size-4" aria-hidden />
                {chosen ? `Issue a PIN for ${chosen.name.split(" ")[0]}` : "Choose somebody first"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{seesEverybodys ? "Issued in the last 24 hours" : "Issued by you in the last 24 hours"}</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((pin) => (
                <li key={pin.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{pin.employeeName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(pin.issuedAt)}
                      {seesEverybodys && pin.issuedByName ? ` · by ${pin.issuedByName}` : ""}
                      {pin.reason ? ` · ${pin.reason}` : ""}
                    </p>
                  </div>
                  <Badge tone={STATE_TONE[pin.state]}>
                    {pin.state === "USED" ? "used" : pin.state === "EXPIRED" ? "expired" : "live"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
