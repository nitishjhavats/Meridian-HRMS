"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TBody, TD, TH, THead, Table, TableWrap, TR } from "@/components/ui/table";
import { formatMoney, formatMoneyCompact } from "@/lib/utils";

/**
 * Monthly collections.
 *
 * One measure, one hue, one axis. Discount and seat counts live in the tooltip
 * rather than becoming a second series — two money measures of different
 * magnitude on one plot is exactly the dual-axis mistake that makes a revenue
 * chart unreadable.
 *
 * The palette is a single brand hue validated for contrast against both the
 * light and dark chart surfaces, so no legend is needed: the title names the
 * series. A table view sits behind a toggle for anyone who cannot read the plot.
 */

export interface MonthlyPoint {
  year: number;
  month: number;
  label: string;
  collectedPaise: number;
  discountPaise: number;
  orders: number;
  seats: number;
}

export function RevenueChart({ data }: { data: MonthlyPoint[] }) {
  const [showTable, setShowTable] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Steps chosen per theme rather than flipped automatically — a light-mode hue
  // dropped onto a dark surface loses its contrast.
  const series = dark ? "#6b7ff0" : "#3b4cca";
  const muted = dark ? "#8a8fa3" : "#6b7280";
  const grid = dark ? "#33364a" : "#e6e7ec";

  const peak = data.reduce(
    (best, point) => (point.collectedPaise > (best?.collectedPaise ?? -1) ? point : best),
    data[0],
  );
  const total = data.reduce((sum, p) => sum + p.collectedPaise, 0);

  if (total === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">
        No collections recorded in this period yet.
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Collections by month</p>
          <p className="text-xs text-muted-foreground">
            Recognised when a payment is approved, not when the order is raised.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
          <Table2 className="size-4" aria-hidden />
          {showTable ? "Show chart" : "Show table"}
        </Button>
      </div>

      {showTable ? (
        <TableWrap>
          <Table>
            <THead>
              <tr>
                <TH>Month</TH>
                <TH numeric>Collected</TH>
                <TH numeric>Discount</TH>
                <TH numeric>Orders</TH>
                <TH numeric>Seats</TH>
              </tr>
            </THead>
            <TBody>
              {data.map((p) => (
                <TR key={`${p.year}-${p.month}`}>
                  <TD>{p.label}</TD>
                  <TD numeric>{formatMoney(p.collectedPaise)}</TD>
                  <TD numeric>{formatMoney(p.discountPaise)}</TD>
                  <TD numeric>{p.orders}</TD>
                  <TD numeric>{p.seats}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={grid} strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: muted, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: grid }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: muted, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value: number) => formatMoneyCompact(value)}
              />
              <Tooltip
                cursor={{ fill: dark ? "#ffffff10" : "#00000008" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const point = payload[0]?.payload as MonthlyPoint;
                  return (
                    <div className="rounded-lg border border-border bg-card p-2.5 text-xs shadow-lg">
                      <p className="font-medium">{point.label}</p>
                      <dl className="mt-1 space-y-0.5">
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Collected</dt>
                          <dd className="tabular font-medium">
                            {formatMoney(point.collectedPaise)}
                          </dd>
                        </div>
                        {point.discountPaise > 0 ? (
                          <div className="flex justify-between gap-4">
                            <dt className="text-muted-foreground">Discount given</dt>
                            <dd className="tabular">{formatMoney(point.discountPaise)}</dd>
                          </div>
                        ) : null}
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Orders</dt>
                          <dd className="tabular">{point.orders}</dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">Seats paid for</dt>
                          <dd className="tabular">{point.seats}</dd>
                        </div>
                      </dl>
                    </div>
                  );
                }}
              />
              <Bar dataKey="collectedPaise" radius={[4, 4, 0, 0]} maxBarSize={44}>
                {data.map((point) => (
                  <Cell
                    key={`${point.year}-${point.month}`}
                    fill={series}
                    // The quiet months stay legible without competing with the peak.
                    fillOpacity={point.collectedPaise === 0 ? 0.15 : 1}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {!showTable && peak && peak.collectedPaise > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Best month: <strong className="text-foreground">{peak.label}</strong> at{" "}
          {formatMoney(peak.collectedPaise)}. Total across the window{" "}
          {formatMoney(total)}.
        </p>
      ) : null}
    </div>
  );
}
