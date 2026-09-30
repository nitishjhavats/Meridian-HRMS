import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The month in the URL goes through `resolveMonthParam` before it reaches the
 * service. `Number(params.month) || thisMonth` let `13` through, and
 * `getMonthlyGrid` threw it into the generic error page. The clamp itself is
 * tested in `monthParam.test.ts`; this is that the page uses it.
 */

const PAGE = "src/app/(app)/attendance/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/attendance with a hand-edited month", () => {
  const body = code(PAGE);

  it("resolves the month through the clamp", () => {
    expect(body).toMatch(/const \{ year, month \} = resolveMonthParam\(params, today\)/);
    expect(body).toMatch(/getMonthlyGrid\(ctx, \{ year, month \}\)/);
  });

  it("and never hands a raw parameter to the service", () => {
    expect(body).not.toMatch(/Number\(params\.(year|month)\)/);
  });
});
