/**
 * Layout rules that a page cannot break without somebody noticing.
 *
 *   npm run verify:layout
 *
 * Not a replacement for looking at the thing on a phone — it cannot measure
 * anything. It checks the *patterns* that produced every horizontal-scroll bug
 * this project has actually had, all three of which looked fine in the source
 * and were only visible at 375px:
 *
 *   1. A grid that defines its columns only at a breakpoint. Below that
 *      breakpoint the implicit column is `auto`, which sizes to the widest
 *      child — so a table or a long word drags the whole page wider and clips
 *      whatever sits beside it. Measured once at 434px against a 375px screen.
 *
 *   2. `shrink-0` on the same element as `flex-wrap`. They cancel: a container
 *      that refuses to shrink never becomes narrow enough for its children to
 *      wrap. Four action buttons pushed the document vault 50px off-screen.
 *
 *   3. A `<table>` that is not inside something that scrolls. The rule is
 *      stated in `components/ui/table.tsx`'s own header and is easy to forget.
 *
 * Exit code 1 on any finding, so it can go in front of a push.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const ROOT = path.resolve("src");
const findings: Finding[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const CLASS_ATTR = /className="([^"]*)"/g;

/**
 * Class strings written anywhere, not only in a `className` attribute.
 *
 * The first version of the safe-area rule scanned only `className="..."`,
 * and missed `cn("safe-bottom ... p-4", ...)` in `ui/dialog.tsx` — the same
 * collision, one indirection away. Narrow on purpose: only strings that
 * actually mention a safe-area utility are considered, so this cannot
 * misread an ordinary sentence as a class list.
 */
const SAFE_AREA_STRING = /"([^"]*\bsafe-(?:top|bottom)\b[^"]*)"/g;
const BREAKPOINT_COLS = /^(sm|md|lg|xl|2xl):grid-cols-/;

for (const file of walk(ROOT)) {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  const relative = path.relative(process.cwd(), file);

  lines.forEach((line, index) => {
    for (const match of [...line.matchAll(CLASS_ATTR), ...line.matchAll(SAFE_AREA_STRING)]) {
      const tokens = match[1]!.split(/\s+/).filter(Boolean);

      // 1 — a grid with columns only at a breakpoint
      if (
        tokens.includes("grid") &&
        !tokens.some((t) => t.startsWith("grid-cols-")) &&
        tokens.some((t) => BREAKPOINT_COLS.test(t))
      ) {
        findings.push({
          file: relative,
          line: index + 1,
          rule: "grid has no mobile column track",
          detail:
            'add `grid-cols-[minmax(0,1fr)]`; without it the implicit column sizes to its widest child',
        });
      }

      // 2 — shrink-0 and flex-wrap on the same element
      if (tokens.includes("shrink-0") && tokens.includes("flex-wrap")) {
        findings.push({
          file: relative,
          line: index + 1,
          rule: "shrink-0 cancels flex-wrap",
          detail: "a container that will not shrink never gets narrow enough to wrap",
        });
      }

      // 3 — a safe-area utility on an element that also sets that padding
      //
      // `.safe-top` sets `padding-top` and `.safe-bottom` sets `padding-bottom`,
      // and both are plain utilities in the same cascade layer as `py-*`. So
      // `safe-top py-4` does not *add* the inset to the padding — whichever
      // rule the stylesheet emits later simply wins, and on the kiosk that meant
      // the header lost its padding rather than gaining the status-bar inset.
      // Write the sum yourself: `pt-[calc(1rem+env(safe-area-inset-top))]`.
      const paddingClash: [string, RegExp][] = [
        // `p-2` counts: it sets padding on all four sides, so it collides with
        // both. Leaving it out of the first version of this rule let one real
        // instance through -- the chat composer -- which is exactly the kind of
        // near-miss a rule like this exists to stop.
        ["safe-top", /^(p|py|pt)-/],
        ["safe-bottom", /^(p|py|pb)-/],
      ];
      for (const [safe, conflicting] of paddingClash) {
        if (tokens.includes(safe) && tokens.some((t) => conflicting.test(t))) {
          findings.push({
            file: relative,
            line: index + 1,
            rule: `${safe} collides with the padding beside it`,
            detail:
              "same property, same layer — one replaces the other. Use pt-[calc(...)] / pb-[calc(...)] and add the inset yourself",
          });
        }
      }
    }
  });

  // 4 — a numeric input that coerces on every keystroke
  //
  // `value={n}` with `onChange={(e) => set(Number(e.target.value))}` cannot be
  // emptied: deleting the last character gives "", `Number("")` is 0, and the
  // zero is rendered straight back. Roughly forty fields across fifteen screens
  // had it, and the report was exact -- backspacing leaves one digit that will
  // not delete, so a value has to be typed around the leftover.
  //
  // Both halves are required to fire, which is what keeps this quiet: a
  // `<Select>` may coerce freely (its value set is fixed and cannot be emptied),
  // and a `type="number"` holding string state was never broken. Use
  // `<NumberField>` from components/ui/number-field.tsx.
  // Comments stripped first: `number-field.tsx` quotes the very pattern it
  // exists to replace, and a rule that fires on its own documentation teaches
  // people to work around the rule.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");

  if (
    /type="number"/.test(withoutComments) &&
    /(Number|parseInt|parseFloat)\(e\.target\.value/.test(withoutComments)
  ) {
    const line = lines.findIndex((l) => /(Number|parseInt|parseFloat)\(e\.target\.value/.test(l)) + 1;
    findings.push({
      file: relative,
      line,
      rule: "numeric input coerces on change",
      detail:
        'use <NumberField value onValueChange> — Number("") is 0, so the box cannot be emptied',
    });
  }

  // 8 — `truncate` on copy the product wrote itself
  //
  // `truncate` is for a value that has somewhere else to be read in full: a
  // name in a list whose row opens the record. Static copy has no such place.
  // The round-13 visual pass found the shared `Stat` tile cutting "Active
  // employees" to "Active empl..." on five screens at 375px, and the tile was
  // the only place that label appeared. A label that wraps is still a label.
  // Literal text inside a truncating element is the checkable half of that.
  // `(?:[^>=]|=(?!>))*` walks the rest of the tag without mistaking the `=>`
  // of an inline handler for its end; the line is taken from the match, since
  // the literal may sit on the line after the opening tag.
  const literalTruncate = /className="[^"]*\btruncate\b[^"]*"(?:[^>=]|=(?!>))*>[^<{]*[A-Za-z]{3,}[^<{]*</;
  const truncated = literalTruncate.exec(withoutComments);
  if (truncated) {
    const line = withoutComments.slice(0, truncated.index).split(/\r?\n/).length;
    findings.push({
      file: relative,
      line,
      rule: "static copy is truncated",
      detail: "let it wrap — `truncate` is for values that can be read in full somewhere else",
    });
  }

  // 9 — a <tr> handed to ResponsiveList's `head`
  //
  // `ResponsiveList` wraps `head` in its own `<tr>` (`components/ui/table.tsx`),
  // so `head={<tr>...</tr>}` renders `<tr><tr>` -- invalid HTML that the
  // browser repairs and React then cannot hydrate. The advances list did it
  // and was a hydration error on every visit. `head` takes the cells, in a
  // fragment.
  if (/head=\{\s*<tr[\s>]/.test(withoutComments)) {
    const line = lines.findIndex((l) => /head=\{\s*<tr[\s>]/.test(l)) + 1;
    findings.push({
      file: relative,
      line,
      rule: "ResponsiveList head is a <tr>",
      detail: "pass the <th> cells in a fragment — the list renders the <tr> itself",
    });
  }

  // 10 — a client screen that asks the server and never hears "no"
  //
  // A mount-time `api()` whose rejection nobody catches is a spinner that
  // never ends: the round-13 audit found ten screens stuck on "Loading..."
  // after a 403 or a dropped connection. Every client file that calls `api`
  // or `mutate` from an effect must catch somewhere -- a `try/catch` in the
  // loader, a `.catch(`, or the shared `useViewer`/`LoadFailed` pair.
  //
  // Only the request *inside* the effect counts: a `mutate()` behind a button
  // already toasts its failure, and a countdown timer is not a fetch. The
  // effect body is read up to its dependency array.
  if (/"use client"/.test(withoutComments) && !/\bcatch\b|useViewer|LoadFailed/.test(withoutComments)) {
    // Comments stripped but every newline kept, so `i` is a real line number.
    const effectLines = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .split(/\r?\n/);
    for (let i = 0; i < effectLines.length; i++) {
      if (!/useEffect\(/.test(effectLines[i]!)) continue;
      // A one-line effect (`useEffect(() => setX(y), [])`) closes on its own line.
      if (/\]\);\s*$/.test(effectLines[i]!)) continue;
      for (let j = i; j < effectLines.length; j++) {
        const l = effectLines[j]!;
        if (j > i && /^\s*\}(, \[|\);)/.test(l)) break;
        if (/\bapi[<(]/.test(l)) {
          findings.push({
            file: relative,
            line: i + 1,
            rule: "effect fetch has no failure path",
            detail:
              "catch the rejection and render <LoadFailed onRetry> — a request that fails must not leave the screen loading for ever",
          });
          i = j;
          break;
        }
      }
    }
  }

  // 5 — a raw <table> with nothing that scrolls around it
  if (/<table[\s>]/i.test(source) && !/TableWrap|overflow-x-auto/.test(source)) {
    const line = lines.findIndex((l) => /<table[\s>]/i.test(l)) + 1;
    findings.push({
      file: relative,
      line,
      rule: "table is not in a scrolling container",
      detail: "wrap it in <TableWrap> — the page body must never scroll sideways",
    });
  }

  /**
   * 7 — a table on a phone that is a table on a phone.
   *
   * `ResponsiveList` renders a real table from `sm` up and a card list below
   * it, because a horizontally scrolling table on a phone is technically
   * responsive and practically unusable. Twenty-four screens use it. This rule
   * is what keeps the twenty-fifth from being written with a raw `<table>` and
   * an `overflow-x-auto` that satisfies rule 5 and helps nobody.
   *
   * A hand-rolled `hidden sm:block` table with its own card fallback passes:
   * the platform dashboard does exactly that and is correct. What fails is a
   * table with no small-screen story at all.
   *
   * The exceptions are matrices, and they are matrices on purpose: a month by
   * employees, leave types by designations, statutory identifiers by document.
   * Cards make no sense of a grid whose meaning is the intersection of two
   * axes, so those scroll and say so.
   */
  const MATRIX_EXCEPTIONS = [
    "src/app/(app)/attendance/AttendanceGrid.tsx",
    "src/app/(app)/settings/leave-balances/DesignationAllocations.tsx",
    "src/app/(app)/settings/organisation/Profile.tsx",
    "src/components/legal/Prose.tsx",
    // The table *is* the alternative view of a chart, column for column. Cards
    // would be a third representation of the same five numbers.
    "src/app/(platform)/platform/revenue/RevenueChart.tsx",
    // A preview of whatever columns the chosen report happens to have. They are
    // not known until it runs, so there is no card to write: the table is the
    // shape of the file about to be downloaded, which is the point of showing
    // it.
    "src/app/(app)/reports/ReportRunner.tsx",
    // Employees down, recognition parameters across, and a score in every
    // cell. The meaning is the intersection.
    "src/app/(app)/recognition/settings/MonthlyCycle.tsx",
  ];
  const normalised = relative.split(path.sep).join("/");
  if (
    /<table[\s>]/i.test(source) &&
    !/ResponsiveList/.test(source) &&
    // Order-independent: `hidden overflow-x-auto sm:block` is the same promise
    // as `hidden sm:block`, and the platform dashboard writes it that way.
    !/className="[^"]*\bhidden\b[^"]*\bsm:block\b/.test(source) &&
    !/className="[^"]*\bsm:block\b[^"]*\bhidden\b/.test(source) &&
    !MATRIX_EXCEPTIONS.includes(normalised)
  ) {
    const line = lines.findIndex((l) => /<table[\s>]/i.test(l)) + 1;
    findings.push({
      file: relative,
      line,
      rule: "table has no small-screen form",
      detail:
        "use <ResponsiveList> — a table that only scrolls sideways on a phone is unusable; add to MATRIX_EXCEPTIONS if it is genuinely a matrix",
    });
  }
}

/**
 * 6 — a full-screen frame that is still in the document's flow.
 *
 * The kiosk has now been broken twice by the same shape: it is `100dvh` tall
 * and something *beside* it in `<body>` adds height, so the document scrolls by
 * exactly that much and one of the two branding blocks leaves the screen.
 * First it was `body { padding-bottom: env(safe-area-inset-bottom) }`; then it
 * was `<OnlineStatus />`, a `position: sticky` — and therefore in-flow — banner
 * added to the root layout by somebody who had never opened the kiosk.
 *
 * `h-dvh` cannot defend against that: it only promises the element's own
 * height. `fixed inset-0` is resolved against the viewport and removed from
 * flow, so nothing an ancestor or sibling does can displace it.
 */
const FULL_SCREEN_ROUTES = ["src/app/kiosk/KioskScreen.tsx"];
for (const route of FULL_SCREEN_ROUTES) {
  const file = path.resolve(route);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    findings.push({
      file: route,
      line: 1,
      rule: "full-screen route has moved or been renamed",
      detail: "update FULL_SCREEN_ROUTES in scripts/verify-layout.ts so the rule still applies",
    });
    continue;
  }

  const lines = source.split(/\r?\n/);
  const frame = lines.findIndex((l) => /className="fixed inset-0[^"]*overflow-hidden/.test(l));
  if (frame === -1) {
    const dvh = lines.findIndex((l) => /className="[^"]*\bh-dvh\b/.test(l));
    findings.push({
      file: route,
      line: dvh === -1 ? 1 : dvh + 1,
      rule: "full-screen frame is still in the document flow",
      detail:
        "use `fixed inset-0 ... overflow-hidden`; h-dvh cannot stop a sibling in <body> from making the document taller",
    });
  }
}

if (findings.length === 0) {
  console.log("\nLayout rules: clean.\n");
  process.exit(0);
}

console.log(`\n${findings.length} layout finding(s):\n`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}`);
  console.log(`    ${f.rule} — ${f.detail}\n`);
}
process.exit(1);
