"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
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

/**
 * Putting people on a branch, several at a time.
 *
 * This screen exists because of a measurement rather than a request. On
 * production, every employee in every organisation had no work location — and
 * attendance is only ever measured against a branch somebody is actually on.
 * With none, `requireGps` collects coordinates and never compares them, so two
 * hundred metres and two hundred kilometres are the same answer.
 *
 * Fixing that one profile at a time is one dialog per person, and the
 * organisations that most need a geofence are the ones with the longest
 * rosters. So: pick a branch, tick the people, done.
 *
 * It opens with everybody who has no branch already ticked, because that is
 * the answer nine times out of ten and the tenth is one click away.
 */

interface Person {
  id: string;
  name: string;
  employeeCode: string;
  active: boolean;
  workLocation: string | null;
}

interface Branch {
  id: string;
  name: string;
  active: boolean;
  isPrimary: boolean;
}

export function AssignBranch({ people }: { people: Person[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [branchId, setBranchId] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignable = people.filter((p) => p.active);
  const unassigned = assignable.filter((p) => !p.workLocation);

  useEffect(() => {
    if (!open) return;
    setChosen(new Set(unassigned.map((p) => p.id)));
    setError(null);
    if (branches) return;
    void fetch("/api/settings/structure")
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { workLocations?: Branch[] } | null) => {
        const rows = (payload?.workLocations ?? []).filter((b) => b.active);
        setBranches(rows);
        setBranchId(rows.find((b) => b.isPrimary)?.id ?? rows[0]?.id ?? "");
      })
      .catch(() => setError("The branches could not be loaded. Close this and try again."));
    // `unassigned` is derived from props and would re-tick on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/settings/structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "location-assign",
        employeeIds: [...chosen],
        workLocationId: branchId,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { updated?: number; error?: { message?: string } }
      | null;
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? "That could not be saved.");
      return;
    }
    const name = branches?.find((b) => b.id === branchId)?.name ?? "the branch";
    toast.success(
      `${payload?.updated ?? chosen.size} ${
        (payload?.updated ?? chosen.size) === 1 ? "person is" : "people are"
      } now on ${name}. Their attendance is measured against it.`,
    );
    setOpen(false);
    router.refresh();
  }

  if (assignable.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <MapPin className="size-4" aria-hidden />
          Branch
          {unassigned.length > 0 ? (
            <Badge tone="warning">{unassigned.length}</Badge>
          ) : null}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Which branch do they work from?</DialogTitle>
          <DialogDescription>
            Attendance is measured against the branch somebody is on. Anyone with none can mark
            from anywhere — their location is recorded and never compared.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          {branches !== null && branches.length === 0 ? (
            <Alert tone="warning" title="No branches yet">
              Add a work location under Settings → Organisation first, with the office&rsquo;s own
              coordinates.
            </Alert>
          ) : null}

          {branches && branches.length > 0 ? (
            <div>
              <label htmlFor="assign-branch" className="text-xs font-medium text-muted-foreground">
                Branch
              </label>
              <select
                id="assign-branch"
                value={branchId}
                disabled={busy}
                onChange={(e) => setBranchId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.isPrimary ? " — default" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
              <p className="text-xs font-medium">
                {chosen.size} of {assignable.length} chosen
              </p>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setChosen(new Set(unassigned.map((p) => p.id)))}
                >
                  Only those with none
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setChosen(new Set(assignable.map((p) => p.id)))}
                >
                  Everyone
                </Button>
              </div>
            </div>
            <ul className="max-h-64 divide-y divide-border overflow-y-auto">
              {assignable.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={chosen.has(p.id)}
                      onChange={() => toggle(p.id)}
                      className="size-4"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">{p.employeeCode}</span>
                    </span>
                    {p.workLocation ? (
                      <Badge tone="neutral">{p.workLocation}</Badge>
                    ) : (
                      <Badge tone="warning">no branch</Badge>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            loading={busy}
            disabled={busy || chosen.size === 0 || !branchId}
            onClick={() => void submit()}
          >
            Put {chosen.size} on this branch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
