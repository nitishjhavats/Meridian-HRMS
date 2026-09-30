"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, ChevronLeft, ChevronRight, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState, Spinner } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SignInAs } from "./organisations/[id]/SignInAs";

/**
 * Every organisation, beside the recent payments, on the one page the platform
 * owner actually opens.
 *
 * The full list lives at /platform/organisations and always has. What was
 * missing is that the dashboard is where somebody lands, and getting from there
 * into a customer's account meant a page, a search, a click and another click.
 *
 * Paging is here rather than "show the first ten and a link", because the point
 * of the control is to find *one* organisation, and with a hundred of them the
 * first ten are rarely the ones being looked for.
 */

const PAGE_SIZES = [5, 10, 25, 50, 100];

interface Row {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  status: string;
  activeEmployees: number;
  seats: number;
}

interface Target {
  userId: string;
  name: string;
  email: string;
  role: string;
  employeeCode: string | null;
}

const STATUS_TONE: Record<string, "success" | "info" | "warning" | "danger" | "neutral"> = {
  ACTIVE: "success",
  TRIAL: "info",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  CLOSED: "neutral",
};

export function OrganisationsCard({ initial }: { initial: { rows: Row[]; total: number } }) {
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Impersonation picker: which organisation is open, and who is in it.
  const [picking, setPicking] = useState<Row | null>(null);
  const [targets, setTargets] = useState<Target[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void fetch(`/api/platform/organizations?page=${page}&pageSize=${pageSize}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((payload: { rows: Row[]; total: number }) => {
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("That page could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageSize]);

  useEffect(() => {
    if (!picking) {
      setTargets(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/platform/organizations/${picking.id}/people`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((payload: { targets: Target[] }) => {
        if (!cancelled) setTargets(payload.targets);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [picking]);

  const pages = Math.max(1, Math.ceil(data.total / pageSize));

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-primary" aria-hidden />
            <h2 className="text-sm font-medium">Organisations</h2>
            <span className="text-xs text-muted-foreground">{data.total} in total</span>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Show
            <select
              value={pageSize}
              disabled={busy}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                // A new size makes the old page number meaningless.
                setPage(1);
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              aria-label="Organisations per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? (
          <div className="p-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : data.rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No organisations yet"
            description="The first one to sign up will appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {data.rows.map((org) => (
              <li key={org.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link
                  href={`/platform/organisations/${org.id}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <span className="block truncate text-sm font-medium">{org.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    /{org.slug}
                    {org.city ? ` · ${org.city}` : ""} · {org.activeEmployees} of {org.seats} seats
                  </span>
                </Link>
                <Badge tone={STATUS_TONE[org.status] ?? "neutral"}>
                  {org.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => setPicking(org)}>
                  <UserRoundCog className="size-4" aria-hidden />
                  Sign in as
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between border-t border-border px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {busy ? <Spinner /> : `Page ${data.total === 0 ? 1 : page} of ${pages}`}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || page <= 1}
              aria-label="Previous page"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || page >= pages}
              aria-label="Next page"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={picking !== null} onOpenChange={(open) => !open && setPicking(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign in to {picking?.name}</DialogTitle>
            <DialogDescription>
              Choose whose account to open. Every action is written to{" "}
              <strong>that organisation&rsquo;s</strong> own audit log, naming you.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            {targets === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading the people who have a login…
              </p>
            ) : targets.length === 0 ? (
              <Alert tone="info" title="Nobody here has a login">
                An employee record is not an account. Somebody has to be given a login before you
                can sign in as them.
              </Alert>
            ) : (
              <ul className="divide-y divide-border">
                {targets.map((t) => (
                  <li key={t.userId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.email}
                        {t.employeeCode ? ` · ${t.employeeCode}` : ""}
                      </span>
                    </span>
                    <Badge tone="neutral">{t.role.replaceAll("_", " ").toLowerCase()}</Badge>
                    <SignInAs userId={t.userId} name={t.name} email={t.email} role={t.role} />
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
