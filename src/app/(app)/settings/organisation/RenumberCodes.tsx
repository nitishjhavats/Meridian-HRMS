"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/stat";
import { Alert, LoadFailed, Spinner } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { pluralise } from "@/lib/utils";

/**
 * Put the whole directory on the organisation's own code prefix.
 *
 * Deliberately a preview then a confirmation, never a migration. Nothing in the
 * database keys on an employee code — attendance, payroll, letters and
 * documents all key on the employee's id — so this cannot break history. What
 * it does do is make a payslip somebody already holds disagree with the
 * directory, because that PDF was rendered with the old code inside it. That is
 * the whole risk and it is said here, in those words, before anything runs.
 */

interface Row {
  employeeId: string;
  name: string;
  from: string;
  to: string;
  unchanged: boolean;
}

interface Plan {
  prefix: string;
  rows: Row[];
  changing: number;
}

export function RenumberCodes({ prefix }: { prefix: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  /**
   * A refused preview is said. The preview sits behind the same write guard as
   * the run -- a trial that has ended or a read-only support view gets a 402
   * or 403 from it -- and this used to swallow that: the spinner stopped and
   * the button sat there, and the person could not tell broken from refused.
   */
  async function preview() {
    setLoading(true);
    setDone(null);
    setPreviewError(null);
    try {
      const result = await api<{ plan: Plan }>("/api/employees/renumber");
      setPlan(result.plan);
    } catch (error) {
      setPlan(null);
      setPreviewError(error);
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!plan) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ changed: number }>("/api/employees/renumber", {
          method: "POST",
          body: { expectedChanging: plan.changing },
        }),
      { success: "Everybody renumbered.", error: "Nothing was changed" },
    );
    setBusy(false);
    if (result) {
      setDone(result.changed);
      setPlan(null);
      router.refresh();
    }
  }

  const changing = plan?.rows.filter((r) => !r.unchanged) ?? [];

  return (
    <Section
      title="Renumber everybody"
      description={`Move the whole directory onto ${prefix}001, ${prefix}002 and so on, in joining-date order.`}
    >
      <div className="space-y-4 p-4">
        {done !== null ? (
          <Alert tone="success" title={`${pluralise(done, "person")} renumbered`}>
            The directory is on {prefix} now. Payslips and letters issued before this still show
            the old codes &mdash; the mapping is in the audit log if anybody needs to trace one.
          </Alert>
        ) : null}

        {plan === null ? (
          <>
            <p className="text-sm text-muted-foreground">
              Existing employees keep whatever codes they were given. This puts them all on one
              series.
            </p>
            {previewError !== null && !loading ? (
              <LoadFailed
                compact
                error={previewError}
                what="The preview"
                onRetry={() => void preview()}
              />
            ) : null}
            <Button variant="secondary" loading={loading} onClick={() => void preview()}>
              <Hash className="size-4" aria-hidden />
              Show me what would change
            </Button>
          </>
        ) : plan.changing === 0 ? (
          <>
            <Alert tone="success" title="Nothing to do">
              Every code is already {prefix} in joining-date order.
            </Alert>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Alert tone="warning" title={`${pluralise(plan.changing, "code")} will change`}>
              Nothing in the system breaks &mdash; attendance, payroll and letters are all linked
              to the person, not the code. But <strong>payslips and letters already issued as
              PDFs carry the old code</strong>, so last month&rsquo;s payslip will not match the
              directory. This cannot be undone from here.
            </Alert>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
              <ul className="divide-y divide-border">
                {changing.map((row) => (
                  <li
                    key={row.employeeId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="flex items-center gap-2 font-mono text-xs">
                      <span className="text-muted-foreground line-through">{row.from}</span>
                      <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{row.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button loading={busy} disabled={busy} onClick={() => void apply()}>
                Renumber {pluralise(plan.changing, "person")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Working out the new codes…
          </p>
        ) : null}
      </div>
    </Section>
  );
}
