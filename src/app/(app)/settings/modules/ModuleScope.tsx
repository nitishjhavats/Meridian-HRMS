"use client";

import { useEffect, useState } from "react";
import { Layers, UserRound, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * Switching a module off for a designation, or for one person.
 *
 * Everything ships on now, which is the right way round — but "everything for
 * everybody" is not what an office looks like. The shop floor does not need the
 * reimbursements screen; the one supervisor who coordinates it does.
 *
 * Two layers, and the nearer one wins. Neither can switch a module *on* that
 * the organisation does not have: the toggles above are the ceiling, and these
 * only lower it. That is enforced in `scopedModules`, not here.
 */

interface Override {
  moduleKey: string;
  name: string;
  enabled: boolean;
}

interface Payload {
  available: { key: string; name: string; core: boolean }[];
  designations: { id: string; title: string; overrides: Override[] }[];
  people: { id: string; name: string; email: string; overrides: Override[] }[];
}

export function ModuleScope({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [scope, setScope] = useState<"designation" | "user">("designation");
  const [targetId, setTargetId] = useState("");
  const [moduleKey, setModuleKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Payload>("/api/settings/modules/scope")
      .then(setData)
      .catch(() => undefined);
  }, []);

  async function change(
    next: { scope: "designation" | "user"; targetId: string; moduleKey: string; enabled: boolean | null },
  ) {
    setBusy(true);
    const result = await mutate<Payload>(
      () => api("/api/settings/modules/scope", { method: "PATCH", body: next }),
      { success: next.enabled === null ? "Back to the default." : "Saved." },
    );
    setBusy(false);
    if (result) {
      setData(result);
      setTargetId("");
      setModuleKey("");
    }
  }

  const optional = (data?.available ?? []).filter((m) => !m.core);
  const targets =
    scope === "designation"
      ? (data?.designations ?? []).map((d) => ({ id: d.id, label: d.title }))
      : (data?.people ?? []).map((p) => ({ id: p.id, label: `${p.name} · ${p.email}` }));

  const rows = [
    ...(data?.designations ?? []).flatMap((d) =>
      d.overrides.map((o) => ({
        key: `d-${d.id}-${o.moduleKey}`,
        scope: "designation" as const,
        targetId: d.id,
        who: d.title,
        detail: "Everyone with this designation",
        module: o,
      })),
    ),
    ...(data?.people ?? []).flatMap((p) =>
      p.overrides.map((o) => ({
        key: `u-${p.id}-${o.moduleKey}`,
        scope: "user" as const,
        targetId: p.id,
        who: p.name,
        detail: p.email,
        module: o,
      })),
    ),
  ];

  return (
    <Section
      title="Exceptions"
      description="A module switched off for one designation, or for one person. The switches above stay the ceiling — nothing here can add a module your organisation does not have."
    >
      <div className="space-y-4 p-4">
        {data === null ? (
          <p className="text-sm text-muted-foreground">Loading&hellip;</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No exceptions"
            description="Everybody sees every module your organisation has switched on."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  {row.scope === "designation" ? (
                    <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.module.name} · {row.who}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{row.detail}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={row.module.enabled ? "success" : "danger"}>
                    {row.module.enabled ? "On" : "Off"}
                  </Badge>
                  {canWrite ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Remove the exception for ${row.who}`}
                      onClick={() =>
                        void change({
                          scope: row.scope,
                          targetId: row.targetId,
                          moduleKey: row.module.moduleKey,
                          enabled: null,
                        })
                      }
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canWrite && data ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
            <Field label="For" htmlFor="scopeKind">
              <Select
                id="scopeKind"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as "designation" | "user");
                  setTargetId("");
                }}
              >
                <option value="designation">A designation</option>
                <option value="user">One person</option>
              </Select>
            </Field>

            <Field label={scope === "designation" ? "Designation" : "Person"} htmlFor="scopeTarget">
              <Select
                id="scopeTarget"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Choose&hellip;</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Module" htmlFor="scopeModule">
              <Select
                id="scopeModule"
                value={moduleKey}
                onChange={(e) => setModuleKey(e.target.value)}
              >
                <option value="">Choose&hellip;</option>
                {optional.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex gap-2 sm:col-span-3">
              <Button
                variant="outline"
                disabled={busy || !targetId || !moduleKey}
                onClick={() => void change({ scope, targetId, moduleKey, enabled: false })}
              >
                Switch it off for them
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !targetId || !moduleKey}
                onClick={() => void change({ scope, targetId, moduleKey, enabled: true })}
              >
                Switch it back on
              </Button>
            </div>
          </div>
        ) : null}

        <Alert tone="info" title="The nearer answer wins">
          A person&rsquo;s exception beats their designation&rsquo;s, and a designation&rsquo;s
          beats the organisation&rsquo;s. Removing an exception follows the layer above again.
        </Alert>
      </div>
    </Section>
  );
}
