import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A list of coupons is a list of discounts somebody else is allowed to take.
 *
 * The dropdown at checkout exists so a buyer does not have to be told a code —
 * which means it hands out codes, and every rule about who may use a coupon
 * becomes a rule about who may *see* one. Three of those matter enough to be
 * asserted on the source, because none of them fails loudly: a coupon that
 * leaks is a coupon that works.
 *
 * The decision this hangs on — `validateCoupon` — is tested directly in
 * `domain/billing/billing.test.ts`. Pinning it does not pin the query that
 * chooses which rows reach it.
 */

const ORDERS = "src/services/billing/orders.ts";
const SCHEMA = "prisma/schema.prisma";
const CHECKOUT = "src/app/(app)/billing/SeatPurchase.tsx";
const FORM = "src/app/(platform)/platform/coupons/CouponForm.tsx";
const PLATFORM_API = "src/app/api/platform/coupons/route.ts";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The `where` the checkout list is built from. */
function listQuery(): string {
  const body = code(ORDERS);
  const start = body.indexOf("export async function listCheckoutCoupons");
  expect(start, "no checkout list").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("what a buyer is allowed to see", () => {
  it("only coupons somebody published", () => {
    // Most coupons are emailed to one customer. A list that showed them all
    // would hand every buyer every private deal on the platform.
    expect(listQuery()).toMatch(/listed: true/);
  });

  it("and `listed` is off by default, so publishing is a decision", () => {
    /**
     * The direction of the default is the whole safety of this feature. Every
     * coupon that existed before this shipped keeps its privacy on deploy; a
     * default of true would have published them all at once, silently.
     */
    const schema = source(SCHEMA);
    const start = schema.indexOf("model Coupon {");
    const block = schema.slice(start, schema.indexOf("\n}", start));
    expect(block).toMatch(/listed\s+Boolean\s+@default\(false\)/);
  });

  it("never another organisation's private coupon", () => {
    // `appliesToOrgId` names one buyer. Listing it for anybody else leaks both
    // the offer and the fact that somebody has a private deal.
    expect(listQuery()).toMatch(
      /OR: \[\{ appliesToOrgId: null \}, \{ appliesToOrgId: ctx\.organizationId \}\]/,
    );
  });

  it("and nothing expired, unstarted or switched off", () => {
    const q = listQuery();
    expect(q).toMatch(/active: true/);
    expect(q).toMatch(/startsAt: \{ lte: now \}/);
    expect(q).toMatch(/expiresAt: \{ gte: now \}/);
  });

  it("behind the same permission that lets somebody buy seats", () => {
    expect(listQuery()).toMatch(/requirePermission\(ctx, "org\.billing\.manage"\)/);
  });
});

describe("what it says about a coupon that does not fit this order", () => {
  it("returns it with the reason rather than hiding it", () => {
    /**
     * The owner's answer, and it is a sales decision as much as a UI one: "not
     * for this many users" is the difference between a buyer thinking there are
     * no offers and a buyer working out that thirty more seats would pay for
     * themselves.
     */
    const q = listQuery();
    expect(q).toMatch(/applies: check\.ok/);
    expect(q).toMatch(/reason: check\.ok \? null :/);
  });

  it("judges that against the seat count on screen, not a fixed one", () => {
    // Whether a coupon applies depends on how many seats are being bought, so
    // a list fetched once would go on offering a fifty-seat deal to somebody
    // who has since changed their mind and wants ten.
    expect(listQuery()).toMatch(/userCount: input\.userCount/);
    expect(code(CHECKOUT)).toMatch(/\/api\/billing\/coupons\?userCount=\$\{userCount\}/);
  });

  it("and the screen shows it as unpickable rather than pretending", () => {
    expect(code(CHECKOUT)).toMatch(/disabled=\{!offer\.applies\}/);
  });
});

describe("the buyer's own history is counted, not assumed", () => {
  it("per-organisation uses come from the redemption rows", () => {
    expect(code(ORDERS)).toMatch(/couponRedemption\.count\(\{ where: \{ organizationId, couponId \}/);
  });

  it("and a first purchase means an approved order, not an abandoned one", () => {
    // An order that was raised and never paid is not a purchase. Counting it
    // would refuse a first-time buyer their first-purchase discount for having
    // once opened the page.
    const body = code(ORDERS);
    const start = body.indexOf("async function couponHistory");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/status: "APPROVED"/);
  });

  it("the quote passes that history to the validator", () => {
    // Without this the two new limits are columns nothing reads.
    const body = code(ORDERS);
    const start = body.indexOf("export async function quoteOrder");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/couponHistory\(ctx\.organizationId, coupon\.id\)/);
    expect(block).toMatch(/\.\.\.history/);
  });

  it("and so does approval, which is the last gate before money moves", () => {
    /**
     * An order can sit in the queue while the same organisation spends its last
     * allowed use elsewhere. The check at quote time passing is not a promise
     * that it still passes now.
     */
    // The crediting moved out of the platform service into `approval.ts` so
    // that an issued code could complete it too; the re-check moved with it.
    const approval = code("src/services/billing/approval.ts");
    expect(approval).toMatch(/organizationRedemptions:/);
    expect(approval).toMatch(/hasPurchasedBefore:/);
  });
});

describe("every new condition is reachable from the form", () => {
  /**
   * This codebase's recurring failure: a column in the schema, a branch in the
   * service, and nothing anywhere that can set it. `appliesToOrgId` was exactly
   * that before this round — it had been in the database and the validator from
   * the start, and no screen could ever write it.
   */
  it("per-organisation limit", () => {
    expect(code(FORM)).toMatch(/maxPerOrganisation/);
    expect(code(PLATFORM_API)).toMatch(/maxPerOrganisation:/);
  });

  it("first purchase only", () => {
    expect(code(FORM)).toMatch(/firstPurchaseOnly/);
    expect(code(PLATFORM_API)).toMatch(/firstPurchaseOnly:/);
  });

  it("show it at checkout", () => {
    expect(code(FORM)).toMatch(/set\("listed", v\)/);
    expect(code(PLATFORM_API)).toMatch(/listed:/);
  });

  it("switch it on now", () => {
    // A coupon was always created switched on, so preparing one a day early
    // meant it was live a day early.
    expect(code(FORM)).toMatch(/set\("active", v\)/);
  });

  it("only for one organisation", () => {
    expect(code(FORM)).toMatch(/set\("appliesToOrgId", e\.target\.value\)/);
  });

  it("and blank still means the permissive answer", () => {
    // "agar blank chhor du to default rakhna". An empty box is null, which is
    // no limit — never a zero, which would read as "nobody may use this".
    expect(code(FORM)).toMatch(/appliesToOrgId: form\.appliesToOrgId \|\| null/);
    expect(code("src/services/platform/coupons.ts")).toMatch(
      /maxPerOrganisation: input\.maxPerOrganisation \?\? null/,
    );
  });
});

describe("a coupon that already exists can be published", () => {
  /**
   * The switch on the creation dialog only ever reaches coupons made after it
   * shipped — and the ones already in the database are exactly the ones
   * somebody would want to publish first. The PATCH route has always accepted
   * `listed`; the gap was that no screen could send it.
   *
   * This is the same failure the round keeps finding: a field that exists
   * everywhere except where a person could set it.
   */
  const LIST = "src/app/(platform)/platform/coupons/page.tsx";

  it("there is a switch on the row", () => {
    expect(code(FORM)).toMatch(/export function CouponListedToggle/);
    expect(code(LIST)).toMatch(/<CouponListedToggle/);
  });

  it("on the card as well as the table, so a phone can do it too", () => {
    const uses = code(LIST).match(/<CouponListedToggle/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("and it sends the field the route accepts", () => {
    expect(code(FORM)).toMatch(/body: \{ listed: next \}/);
    expect(code("src/app/api/platform/coupons/[id]/route.ts")).toMatch(/listed:/);
  });

  it("the row says which state it is in without being switched", () => {
    // "code only" and "shown at checkout" are both written, so the answer is
    // legible rather than inferred from a switch position.
    expect(code(LIST)).toMatch(/shown at checkout/);
    expect(code(LIST)).toMatch(/code only/);
  });
});
