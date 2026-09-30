import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The platform's read-only support view may look at an organisation's export
 * list -- `listExports` reads with a permission, not writability -- but
 * `requestExport`, `revealPassword` and `downloadExport` all refuse it. The
 * page must render for that visit with the controls withheld, not throw on
 * the read and not offer a button that toasts.
 */

const PAGE = "src/app/(app)/settings/export/page.tsx";
const PANEL = "src/app/(app)/settings/export/ExportPanel.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/settings/export in the read-only support view", () => {
  it("the page has one guard, on the permission, and reads with listExports alone", () => {
    const body = code(PAGE);
    expect(body).toMatch(/pageGuard\(ctx, \{ permission: "org\.data\.export"/);
    expect(body).toMatch(/await listExports\(ctx\)/);
    expect(body).not.toMatch(/requireWrit/);
    expect(body).not.toMatch(/requestExport/);
  });

  it("tells the panel it is read-only", () => {
    expect(code(PAGE)).toMatch(/<ExportPanel jobs=\{jobs\} readOnly=\{ctx\.readOnlyView\} \/>/);
  });

  it("and the panel withholds the build button and the row actions", () => {
    const body = code(PANEL);
    expect(body).toMatch(/readOnly = false/);
    expect(body).toMatch(/<Button onClick=\{build\} loading=\{building\} disabled=\{readOnly\}>/);
    expect(body.match(/\{readOnly \? null : \(\s*<RowActions/g)).toHaveLength(2);
  });
});
