"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { useViewer } from "@/lib/client/useViewer";

/**
 * The organisation's half of the two-level feature system.
 *
 * A toggle here can only ever narrow what the platform granted, so the row for
 * an ungranted module is shown but locked — hiding it entirely would leave an
 * admin wondering why a feature they read about does not exist.
 *
 * The page opens on `org.settings.read` and the switches move on
 * `org.modules.manage`, which is a different, sensitive permission: an HR
 * manager can see which modules are on and cannot change them. For them the
 * switches are disabled and the reason is written above, the way the
 * attendance rules do it, rather than every flip ending in a refusal toast.
 */

export interface ModuleRow {
  key: string;
  name: string;
  description: string;
  core: boolean;
  granted: boolean;
  enabled: boolean;
  live: boolean;
  toggleable: boolean;
  requires: string[];
  requiredBy: string[];
  blockedBy?: "NOT_GRANTED" | "DISABLED" | "MISSING_DEPENDENCY";
  missingDependency?: string;
}

export function ModuleToggles({
  initial,
  canWrite,
}: {
  initial: ModuleRow[];
  /**
   * Whether the viewer holds `org.modules.manage`. The page knows and should
   * say; left out, it is asked for after mount, and the switches stay disabled
   * until the answer arrives -- a switch that moves and is then refused is
   * worse than one that waits a moment.
   */
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [modules, setModules] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const viewer = useViewer(canWrite === undefined);
  // null while nobody has said yet.
  const mayChange: boolean | null =
    canWrite ?? (viewer ? viewer.permissions.has("org.modules.manage") : null);

  const byKey = new Map(modules.map((m) => [m.key, m]));

  async function toggle(row: ModuleRow, enabled: boolean) {
    setPending(row.key);
    const result = await mutate(
      () =>
        api<{ modules: ModuleRow[] }>("/api/settings/modules", {
          method: "PATCH",
          body: { modules: { [row.key]: enabled } },
        }),
      {
        success: `${row.name} ${enabled ? "switched on" : "switched off"}.`,
        error: `${row.name} was not changed`,
      },
    );
    setPending(null);
    if (result) {
      setModules(result.modules);
      // The sidebar is derived from the same resolver, so it has to be re-fetched.
      router.refresh();
    }
  }

  const core = modules.filter((m) => m.core);
  const optional = modules.filter((m) => !m.core);

  return (
    <div className="space-y-4">
      {mayChange === false ? (
        <Alert tone="info" title="You can see these modules but not change them">
          Changing which modules are on needs the “Switch modules on and off” permission. Ask an
          administrator.
        </Alert>
      ) : null}

      <Alert tone="info" title="Switching a module off hides it, it does not delete anything">
        Data stays exactly where it is. Turning the module back on brings it back untouched.
      </Alert>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Always on</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {core.map((row) => (
            <li key={row.key} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {row.name}
                  <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                </p>
                <p className="text-xs text-muted-foreground">{row.description}</p>
              </div>
              <Badge tone="neutral">Core</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Optional modules</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {optional.map((row) => {
            const dependency = row.missingDependency
              ? (byKey.get(row.missingDependency)?.name ?? row.missingDependency)
              : null;

            return (
              <li key={row.key} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {row.name}
                    {!row.granted ? <Badge tone="warning">Not available</Badge> : null}
                    {row.granted && row.enabled && !row.live ? (
                      <Badge tone="warning">Blocked</Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{row.description}</p>

                  {!row.granted ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-warning-text">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                      Your plan does not include this. Ask the platform owner to enable it.
                    </p>
                  ) : dependency ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-warning-text">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                      Needs {dependency}, which is off.
                    </p>
                  ) : row.enabled && row.requiredBy.length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Switching this off also stops{" "}
                      {row.requiredBy
                        .map((k) => byKey.get(k)?.name ?? k)
                        .join(" and ")}
                      .
                    </p>
                  ) : null}
                </div>

                <Switch
                  checked={row.enabled}
                  disabled={!mayChange || !row.toggleable || pending === row.key}
                  onCheckedChange={(v) => toggle(row, v)}
                  aria-label={row.name}
                />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
