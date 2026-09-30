import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRESENT_STATUSES as HEADCOUNT_PRESENT } from "./policy";
import { PRESENT_STATUSES as MONTH_PRESENT } from "./monthTotals";

/**
 * `CHECKED_IN` is the thirteenth status, and most of the places that read a
 * status are not typed against the union. A `Record<string, ...>` keyed on
 * status compiles whether or not it names the new one; what it does at runtime
 * is fall through to `?? CELL.NOT_MARKED` or render `undefined`, so a person
 * standing in the office reads as not marked on one screen and as a blank
 * letter on another. The compiler cannot catch that. This walks the tree and
 * does.
 *
 * A status map, for the purpose of this file, is any object literal whose own
 * keys include both `HALF_DAY` and `NOT_MARKED`. Arrays are deliberately not
 * maps: the override options and the override route's enum leave `CHECKED_IN`
 * out on purpose, because a day in progress is never a verdict an
 * administrator hands down.
 */

const SRC = path.resolve("src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments out, line numbers kept: a block comment leaves its newlines behind. */
const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Whether the file has anything to do with attendance.
 *
 * "Imports something attendance-related" alone is not enough: the attendance
 * matrix imports only UI primitives and the API client, and it is the screen
 * this exists for. So the path counts too, and so does naming the status type.
 */
function attendanceRelated(file: string, code: string): boolean {
  if (/attendance/i.test(path.relative(SRC, file))) return true;
  if (/AttendanceStatus/.test(code)) return true;
  const imports = code.match(/from\s+["'][^"']+["']/g) ?? [];
  return imports.some((spec) => /attendance/i.test(spec));
}

/** The index of the `}` that closes the `{` at `open`, or -1. Strings are skipped. */
function closingBrace(code: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The literal's text with everything nested one level down blanked out. */
function ownLevel(body: string): string {
  let depth = 0;
  let quote: string | null = null;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += body[++i] ?? "";
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      out += depth === 0 ? ch : " ";
      depth++;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      out += depth === 0 ? ch : " ";
    } else {
      out += depth === 0 ? ch : " ";
    }
  }
  return out;
}

/** Keys written in SCREAMING_CASE at the literal's own level. */
function ownKeys(literal: string): string[] {
  const inner = ownLevel(literal.slice(1, -1));
  const keys: string[] = [];
  for (const match of inner.matchAll(/(?:^|[{,])\s*"?([A-Z][A-Z0-9_]*)"?\s*:/g)) {
    keys.push(match[1]!);
  }
  return keys;
}

interface StatusMap {
  file: string;
  line: number;
  keys: string[];
}

function statusMapsIn(file: string): StatusMap[] {
  const code = stripComments(readFileSync(file, "utf8"));
  const maps: StatusMap[] = [];
  for (let open = code.indexOf("{"); open !== -1; open = code.indexOf("{", open + 1)) {
    const close = closingBrace(code, open);
    if (close === -1) continue;
    const keys = ownKeys(code.slice(open, close + 1));
    if (keys.includes("HALF_DAY") && keys.includes("NOT_MARKED")) {
      const line = code.slice(0, open).split("\n").length;
      maps.push({ file: path.relative(process.cwd(), file).replace(/\\/g, "/"), line, keys });
    }
  }
  return maps;
}

const thisFile = fileURLToPath(import.meta.url);

const candidates = walk(SRC).filter((file) => {
  if (path.resolve(file) === path.resolve(thisFile)) return false;
  const code = readFileSync(file, "utf8");
  return /\bHALF_DAY\b/.test(code) && /\bNOT_MARKED\b/.test(code) && attendanceRelated(file, code);
});

const found = candidates.flatMap(statusMapsIn);

describe("every status-keyed map names CHECKED_IN", () => {
  it("finds the maps at all", () => {
    // A guard that finds nothing has broken, not passed. The labels table in
    // policy.ts is typed against the union and is always here.
    const where = found.map((m) => `${m.file}:${m.line}`);
    console.info(`status-keyed maps checked: ${where.join(", ")}`);
    expect(where).toEqual(expect.arrayContaining([expect.stringMatching(/domain\/attendance\/policy\.ts:\d+/)]));
  });

  it("and each of them names CHECKED_IN", () => {
    const missing = found
      .filter((m) => !m.keys.includes("CHECKED_IN"))
      .map((m) => `${m.file}:${m.line}`);
    expect(missing, `status maps with no CHECKED_IN key: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the headcount and the month tally both count a day in progress", () => {
  it("as present, in the domain lists", () => {
    expect(HEADCOUNT_PRESENT).toContain("CHECKED_IN");
    expect(MONTH_PRESENT).toContain("CHECKED_IN");
  });

  it.each([
    ["src/services/dashboard.ts", "@/domain/attendance/policy"],
    ["src/services/reports/index.ts", "@/domain/attendance/monthTotals"],
  ])("%s imports PRESENT_STATUSES from %s rather than spelling its own list", (file, from) => {
    // Each of these used to carry a private copy of the present list, which is
    // how a status added to the domain reached the grid and not the tile
    // beside it. A list here that names FULL_DAY is that copy coming back.
    const code = stripComments(readFileSync(path.resolve(file), "utf8"));
    expect(code).toMatch(
      new RegExp(`import\\s*\\{[^}]*\\bPRESENT_STATUSES\\b[^}]*\\}\\s*from\\s*"${from}"`),
    );
    expect(code).not.toMatch(/\[[^\]]*"FULL_DAY"[^\]]*\]/);
  });
});
