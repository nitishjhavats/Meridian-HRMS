"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Ticking several people.
 *
 * The shape is the one the branch assignment on the employees screen arrived
 * at — a checkbox list, a running count, and a way to take the whole list in
 * one click — but that one is welded to work locations, so this is the generic
 * half: it takes people and gives back ids, and knows nothing about what is
 * being done to them.
 *
 * The search box appears only once the list is long enough to need it. Below
 * that it is a control that costs a row of height and saves nothing, and a
 * filter you cannot see the effect of is how people end up assigning something
 * to eight of their twenty.
 *
 * Select-all deliberately applies to what is *shown*: with a filter typed in,
 * "select all" meaning the hidden hundred as well is how the wrong people get
 * picked. The count above the list always names the full total, so a narrowed
 * list can never be mistaken for the whole one.
 */

export interface PickablePerson {
  id: string;
  name: string;
  employeeCode: string;
  /** A second line under the name — a department, a designation, a branch. */
  detail?: string | null;
}

export function EmployeePicker({
  people,
  selected,
  onChange,
  disabled = false,
  searchFrom = 8,
  emptyMessage = "Nobody to choose from.",
}: {
  people: PickablePerson[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** List length at which the search box earns its place. */
  searchFrom?: number;
  emptyMessage?: string;
}) {
  const [query, setQuery] = useState("");
  const chosen = useMemo(() => new Set(selected), [selected]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.employeeCode.toLowerCase().includes(needle) ||
        (p.detail ?? "").toLowerCase().includes(needle),
    );
  }, [people, query]);

  function toggle(id: string) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Emitted in the list's own order rather than click order, so a caller that
    // shows the names back gets them the way they are read on screen.
    onChange(people.filter((p) => next.has(p.id)).map((p) => p.id));
  }

  if (people.length === 0) {
    return (
      <p className="rounded-lg border border-border px-3 py-4 text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-xs font-medium">
          {chosen.size} of {people.length} chosen
        </p>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={disabled || shown.length === 0}
            onClick={() => {
              const next = new Set(chosen);
              for (const p of shown) next.add(p.id);
              onChange(people.filter((p) => next.has(p.id)).map((p) => p.id));
            }}
          >
            {query.trim() ? `Select these ${shown.length}` : "Select all"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={disabled || chosen.size === 0}
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
      </div>

      {people.length >= searchFrom ? (
        <div className="border-b border-border px-3 py-2">
          <Input
            value={query}
            disabled={disabled}
            aria-label="Search people"
            placeholder="Search by name or code"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">Nobody matches “{query.trim()}”.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto">
          {shown.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={chosen.has(p.id)}
                  disabled={disabled}
                  onChange={() => toggle(p.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.employeeCode}
                    {p.detail ? ` · ${p.detail}` : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
