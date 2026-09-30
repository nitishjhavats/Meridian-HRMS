import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Seeing your own leave and balances is not the same right as applying for it
 * -- the page says so in its guard, and then called `listLeaveTypes`, which
 * asks for `leave.request`. Revoke that on a contractor and My leave threw,
 * showing neither the balances nor the history the guard had just allowed.
 */

const PAGE = "src/app/(app)/me/leave/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/me/leave without leave.request", () => {
  const body = code(PAGE);

  it("guards on reading, and balances and history need nothing more", () => {
    expect(body).toMatch(/permission: "leave\.read\.self"/);
    expect(body).toMatch(/getLeaveBalances\(ctx, ctx\.employeeId\)/);
    expect(body).toMatch(/listLeaveRequests\(ctx, \{ employeeId: ctx\.employeeId \}\)/);
  });

  it("lists leave types only for somebody who may apply", () => {
    expect(body).toMatch(/ctx\.permissions\.has\("leave\.request"\)/);
    expect(body).toMatch(/canRequest \? listLeaveTypes\(ctx\) : Promise\.resolve\(\[\]\)/);
    expect(body.match(/listLeaveTypes\(ctx\)/g)).toHaveLength(1);
  });

  it("and offers the form to them alone", () => {
    expect(body).toMatch(/\{canRequest \? \(\s*<RequestLeave types=\{types\} \/>/);
    expect(body).toMatch(/<Alert tone="info" title="Applying for leave is switched off for your login">/);
  });
});
