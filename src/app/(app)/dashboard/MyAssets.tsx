"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Laptop } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/stat";
import { api, mutate } from "@/lib/client/api";
import { formatDate, pluralise } from "@/lib/utils";
import type { MyAssetRow } from "@/services/assets";

/**
 * Company property issued to the signed-in person, with the one thing they
 * are asked to do about it.
 *
 * This is the only asset screen an ordinary employee has. The register is
 * `asset.manage`, so "Company property issued to you -- please acknowledge
 * it" used to link them to a page that refused them, and the register's
 * "Unacknowledged" count could never come down. The notification now lands
 * on this card's anchor; the section id is what `MY_ASSETS_LINK` points at.
 *
 * Acknowledging posts to the register's own route, which checks that the
 * assignment belongs to the caller -- there is no separate employee-side
 * endpoint to keep in step.
 */
export function MyAssets({ initial }: { initial: MyAssetRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const waiting = initial.filter((a) => !a.acknowledged).length;

  async function acknowledge(row: MyAssetRow) {
    setBusy(row.assignmentId);
    const ok = await mutate(
      () =>
        api(`/api/assets/${row.assetId}`, {
          method: "POST",
          body: { action: "acknowledge", assignmentId: row.assignmentId },
        }),
      { success: `${row.assetTag} acknowledged.`, error: "That could not be acknowledged" },
    );
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  return (
    <div id="my-assets" className="scroll-mt-20">
      <Section
        title="Issued to you"
        description={
          waiting > 0
            ? `${pluralise(waiting, "item")} waiting for you to confirm you have it`
            : pluralise(initial.length, "item")
        }
      >
        <ul className="divide-y divide-border">
          {initial.map((a) => (
            <li key={a.assignmentId} className="flex items-center gap-3 px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Laptop className="size-4.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {a.name} <span className="font-mono text-xs text-muted-foreground">{a.assetTag}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {a.categoryLabel} · issued {formatDate(a.issuedOn)}
                  {a.dueOn ? ` · due back ${formatDate(a.dueOn)}` : ""}
                </span>
              </span>
              {a.overdue ? <Badge tone="danger">Overdue</Badge> : null}
              {a.acknowledged ? (
                <Badge tone="success">
                  <Check className="size-3" aria-hidden />
                  Acknowledged
                </Badge>
              ) : (
                <Button size="sm" loading={busy === a.assignmentId} onClick={() => acknowledge(a)}>
                  Acknowledge
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
