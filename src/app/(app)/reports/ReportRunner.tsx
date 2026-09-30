"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { TBody, TD, TH, THead, Table, TableWrap, TR } from "@/components/ui/table";
import { RequestFailed, api } from "@/lib/client/api";
import { MONTH_NAMES } from "@/domain/date";

/**
 * Running a report.
 *
 * The preview and the download come from the same endpoint and the same rows —
 * `?format=json` versus CSV — so what somebody checks on screen is what lands
 * in the file. A preview built from a second query is a preview that can lie.
 */

export interface ReportOption {
  kind: string;
  name: string;
  description: string;
  needs: string[];
}

interface Preview {
  name: string;
  filename: string;
  header: (string | number | null)[];
  rows: (string | number | null)[][];
  total: number;
}

export function ReportRunner({ reports }: { reports: ReportOption[] }) {
  const now = new Date();
  const [kind, setKind] = useState(reports[0]?.kind ?? "");
  const [year, setYear] = useState(now.getUTCFullYear());
  // Default to the last finished month — the one people actually report on.
  const [month, setMonth] = useState(now.getUTCMonth() === 0 ? 12 : now.getUTCMonth());
  const [from, setFrom] = useState(`${now.getUTCFullYear()}-01-01`);
  const [to, setTo] = useState(now.toISOString().slice(0, 10));

  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = reports.find((r) => r.kind === kind);
  const needsMonth = selected?.needs.includes("month") ?? false;
  const needsRange = selected?.needs.includes("dateRange") ?? false;

  function query(format: "json" | "csv"): string {
    const params = new URLSearchParams({ format });
    if (needsMonth) {
      params.set("year", String(year));
      params.set("month", String(month));
    }
    if (needsRange) {
      params.set("from", from);
      params.set("to", to);
    }
    if (!needsMonth && !needsRange) params.set("year", String(year));
    return params.toString();
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api<Preview>(`/api/reports/${kind}?${query("json")}`));
    } catch (err) {
      setPreview(null);
      setError(err instanceof RequestFailed ? err.error.message : "That report could not be run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Report" htmlFor="reportKind" required>
            <Select
              id="reportKind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPreview(null);
              }}
            >
              {reports.map((r) => (
                <option key={r.kind} value={r.kind}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>

          {needsMonth ? (
            <>
              <Field label="Month" htmlFor="reportMonth">
                <Select
                  id="reportMonth"
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Year" htmlFor="reportYear">
                <NumberField
                  id="reportYear"
                  min={2000}
                  max={2100}
                  className="tabular"
                  value={year}
                  // An empty box is a year half-typed, not a year of nothing: the
                  // last one stands until a new one is finished, so Run and the
                  // CSV link always carry a real year.
                  onValueChange={(v) => setYear(v ?? year)}
                />
              </Field>
            </>
          ) : null}

          {needsRange ? (
            <>
              <Field label="From" htmlFor="reportFrom">
                <Input id="reportFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To" htmlFor="reportTo">
                <Input id="reportTo" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </>
          ) : null}

          {!needsMonth && !needsRange ? (
            <Field label="Year" htmlFor="reportYearOnly">
              <NumberField
                id="reportYearOnly"
                min={2000}
                max={2100}
                className="tabular"
                value={year}
                onValueChange={(v) => setYear(v ?? year)}
              />
            </Field>
          ) : null}
        </div>

        {selected ? (
          <p className="mt-2 text-xs text-muted-foreground">{selected.description}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button loading={busy} onClick={run}>
            <Play className="size-4" aria-hidden />
            Run
          </Button>
          {preview ? (
            <a
              href={`/api/reports/${kind}?${query("csv")}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              <Download className="size-4" aria-hidden />
              Download CSV ({preview.total} rows)
            </a>
          ) : null}
        </div>

        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </div>

      {preview ? (
        preview.total === 0 ? (
          <Alert tone="info" title="Nothing to report">
            No rows matched. Try a different month, or check that the data exists.
          </Alert>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">{preview.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {preview.total} row{preview.total === 1 ? "" : "s"}
                  {preview.rows.length < preview.total
                    ? ` · showing the first ${preview.rows.length}`
                    : ""}
                </p>
              </div>
              <FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden />
            </div>

            <TableWrap>
              <Table>
                <THead>
                  <tr>
                    {preview.header.map((h, i) => (
                      <TH key={i}>{String(h ?? "")}</TH>
                    ))}
                  </tr>
                </THead>
                <TBody>
                  {preview.rows.map((row, i) => (
                    <TR key={i}>
                      {row.map((cell, j) => (
                        <TD key={j} numeric={typeof cell === "number"}>
                          {cell === null || cell === "" ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            String(cell)
                          )}
                        </TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </div>
        )
      ) : null}
    </div>
  );
}
