import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withoutIssuedCode } from "@/services/billing/customerOrder";
import { orderRow } from "@/services/billing/fakeBillingDb.testkit";

/**
 * The platform owner's payment screens, and what they are sent.
 *
 * The order detail and every review action (approve, reject, ask for more,
 * issue a code) returned the whole order row, so the issued code's hash and
 * cipher sat in the superadmin's browser for no reason: the screens only ask
 * whether a code exists, and reading one back is its own deliberate action
 * (`reveal_code`). And a fresh install, with no payee yet, could not save any
 * platform setting, because the empty UPI box failed the UPI pattern.
 */

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the superadmin is never sent the issued code", () => {
  it("withoutIssuedCode drops the hash and the cipher and says whether one exists", () => {
    const view = withoutIssuedCode(
      orderRow({ issuedCodeHash: "bcrypt-hash", issuedCodeCipher: "v1.iv.tag.ct" }),
    );
    const json = JSON.stringify(view);
    expect(json).not.toContain("bcrypt-hash");
    expect(json).not.toContain("v1.iv.tag.ct");
    expect(json).not.toMatch(/"issuedCode(Hash|Cipher)"/);
    expect(view.hasIssuedCode).toBe(true);
    expect(withoutIssuedCode(orderRow()).hasIssuedCode).toBe(false);
  });

  it("the order detail goes through it", () => {
    const body = code("src/services/platform/payments.ts");
    const detail = body.slice(body.indexOf("export async function getOrderDetail"));
    expect(detail).toMatch(/\.\.\.withoutIssuedCode\(order\)/);
    expect(detail.slice(0, detail.indexOf("\n}\n"))).not.toMatch(/\.\.\.order,/);
  });

  it("and the organisation page's recent orders", () => {
    const body = code("src/services/platform/organizations.ts");
    expect(body).toMatch(/paymentOrders: org\.paymentOrders\.map\(withoutIssuedCode\)/);
  });

  it("and so does every review action's answer", () => {
    const route = code("src/app/api/platform/payments/[id]/action/route.ts");
    const answers = route.match(/order: [^}\n]+/g) ?? [];
    expect(answers.length).toBe(4);
    for (const answer of answers) expect(answer).toMatch(/withoutIssuedCode\(/);
  });
});

describe("platform settings with no payee yet", () => {
  const body = code("src/services/platform/settings.ts");

  it("an empty UPI box is not checked against the UPI pattern", () => {
    expect(body).toMatch(/if \(patch\.paymentUpiId\?\.trim\(\) && !UPI_PATTERN\.test/);
  });

  it("and never overwrites a stored payee", () => {
    expect(body).toMatch(/paymentUpiId: rest\.paymentUpiId\?\.trim\(\) \|\| undefined,/);
  });
});
