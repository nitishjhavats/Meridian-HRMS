import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Who used this coupon" answers with organisations, not ids.
 *
 * `CouponRedemption` stores the organisation's id and has no relation to it,
 * so the dialog behind the people icon listed cuids with an amount beside
 * each -- a screen that exists to say which organisations used a code and
 * could not. The service now resolves the names in one query over the
 * distinct ids, and the dialog renders the name with the id as the fallback
 * for an organisation that no longer exists.
 */

const SERVICE = "src/services/platform/coupons.ts";
const DIALOG = "src/app/(platform)/platform/coupons/CouponRedemptions.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("getCouponRedemptions", () => {
  const block = bodyOf(SERVICE, "export async function getCouponRedemptions");

  it("looks the organisations up by the distinct ids, in one query", () => {
    expect(block).toMatch(/new Set\(redemptions\.map\(\(r\) => r\.organizationId\)\)/);
    expect(block).toMatch(/prisma\.organization\.findMany\(\{\s*where: \{ id: \{ in: organizationIds \} \}/);
  });

  it("and skips the query when there is nothing to look up", () => {
    expect(block).toMatch(/organizationIds\.length === 0\s*\?\s*\[\]/);
  });

  it("hands back organizationName on every row, null when the organisation is gone", () => {
    expect(block).toMatch(/organizationName: nameOf\.get\(r\.organizationId\) \?\? null/);
  });
});

describe("the redemptions dialog", () => {
  const dialog = code(DIALOG);

  it("renders the name, and falls back to the id rather than to nothing", () => {
    expect(dialog).toMatch(/\{row\.organizationName \?\? row\.organizationId\}/);
    expect(dialog).not.toMatch(/>\s*\{row\.organizationId\}\s*</);
  });
});
