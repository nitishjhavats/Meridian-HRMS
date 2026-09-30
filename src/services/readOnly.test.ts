import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Read-only means read-only, not broken.
 *
 * When a trial ends or a payment lapses, `requireWritable` refuses writes and
 * the shell says so in a banner. Five pages then crashed anyway, because the
 * *read* that built them called `requireWrite`: the profile, the documents
 * queue, advances, reimbursement payouts, chat reports -- and the employee
 * form's option lists, so every Add/Edit dialog opened on an error. Mera
 * Ayurveda's trial ended the day after this was found.
 *
 * Rule: an exported service function whose name says it reads (`get*`,
 * `list*`) does not call `requireWrite`. Previews of writes (`preview*`) are
 * part of a write and may.
 */

const ROOT = path.resolve("src/services");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function code(file: string): string {
  // The tree mixes line endings; a block is cut at a lone closing brace below.
  return readFileSync(file, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("reads never ask for writability", () => {
  it("no exported get*/list* service function calls requireWrite", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const body = code(file);
      for (const match of body.matchAll(/export async function ((?:get|list)\w*)\(/g)) {
        const start = match.index ?? 0;
        const block = body.slice(start, body.indexOf("\n}\n", start));
        if (/\brequireWrite\(/.test(block) || /\brequireWritable\(/.test(block)) {
          offenders.push(`${path.relative(ROOT, file)}:${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the ones that crashed now read with a permission and a module", () => {
    const expectations: [string, string, RegExp][] = [
      ["account/profile.ts", "getMyProfile", /requirePermission\(ctx, "org\.settings\.write"\)/],
      ["documents/index.ts", "listDeletionRequests", /requirePermission\(ctx, "document\.delete\.approve"\)/],
      ["payroll/advances.ts", "listAdvances", /requirePermission\(ctx, "advance\.manage"\)/],
      ["employees/write.ts", "getEmployeeFormOptions", /requirePermission\(ctx, "employee\.read\.all"\)/],
      ["chat/index.ts", "listReports", /requirePermission\(ctx, "chat\.export"\)/],
      ["attendance/pinAuthority.ts", "getPinAuthorities", /requirePermission\(ctx, "org\.settings\.read"\)/],
      ["export/index.ts", "listExports", /requirePermission\(ctx, "org\.data\.export"\)/],
    ];
    for (const [file, fn, guard] of expectations) {
      const body = code(path.join(ROOT, file));
      const start = body.indexOf(`export async function ${fn}(`);
      expect(start, `${file}:${fn}`).toBeGreaterThan(-1);
      const block = body.slice(start, body.indexOf("\n}\n", start));
      expect(block, `${file}:${fn}`).toMatch(guard);
    }
  });

  it("but the writes beside them still do", () => {
    // The point of the change is to move the check, not to lose it.
    const pairs: [string, string][] = [
      ["account/profile.ts", "saveMyProfile"],
      ["attendance/pinAuthority.ts", "grantPinAuthority"],
      ["payroll/advances.ts", "issueAdvance"],
      ["chat/index.ts", "sendMessage"],
    ];
    for (const [file, fn] of pairs) {
      const body = code(path.join(ROOT, file));
      const start = body.indexOf(`export async function ${fn}(`);
      expect(start, `${file}:${fn}`).toBeGreaterThan(-1);
      const block = body.slice(start, body.indexOf("\n}\n", start));
      expect(block, `${file}:${fn}`).toMatch(/requireWrite\(/);
    }
  });
});
