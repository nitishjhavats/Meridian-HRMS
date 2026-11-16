import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/auth/context";
import { generateConfirmationCode } from "@/lib/auth/password";

import { createFakeBillingDb, orderRow } from "./fakeBillingDb.testkit";

/**
 * What an organisation's billing endpoints hand back about its own orders.
 *
 * They returned the whole `PaymentOrder` row, and the row carries the hash
 * and the cipher of the six-digit code the platform owner issues against an
 * order. A bcrypt hash of a six-digit number is a million guesses offline,
 * and typing the code back in *approves the order* -- seats without paying.
 * Every customer-facing function now returns a field-by-field copy that
 * leaves the code, its issuer and the reviewer out, and says only whether a
 * code has been issued.
 */

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeBillingDb> }));

vi.mock("@/lib/db/prisma", () => ({
  get prisma() {
    return fake.db.prisma;
  },
}));
vi.mock("@/lib/audit", () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify", () => ({
  notify: { toOrgRoles: vi.fn(async () => undefined), toSuperadmins: vi.fn(async () => undefined) },
}));
vi.mock("@/lib/ratelimit", () => ({ enforce: vi.fn(async () => undefined) }));

const { toCustomerOrder } = await import("./customerOrder");
const orders = await import("./orders");

const ctx = {
  userId: "user_owner",
  organizationId: "org_1",
  organization: { name: "Acme" },
  permissions: new Set(["org.billing.manage"]),
} as unknown as AuthContext;

/** Keys that must never leave the server on an organisation's request. */
const SECRET_KEYS = [
  "issuedCodeHash",
  "issuedCodeCipher",
  "codeIssuedById",
  "codeAttemptCount",
  "confirmationCode",
  "reviewedById",
  "createdById",
  "couponId",
  "organizationId",
];

function expectNothingSecret(value: unknown, hash: string) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(hash);
  for (const key of SECRET_KEYS) expect(json).not.toContain(`"${key}"`);
}

let issued: { plaintext: string; hash: string };

beforeEach(async () => {
  vi.clearAllMocks();
  fake.db = createFakeBillingDb();
  fake.db.state.platformSetting = {
    id: "singleton",
    pricePerUserPaise: 5_900,
    currency: "INR",
    paymentUpiId: "payee@example",
    paymentPayeeName: "HRMS Platform",
    paymentWindowMinutes: 240,
    confirmationMode: "BOTH",
  };
  issued ??= await generateConfirmationCode();
  fake.db.state.paymentOrders.set(
    "order_1",
    orderRow({
      status: "AWAITING_CONFIRMATION",
      issuedCodeHash: issued.hash,
      issuedCodeCipher: "v1.iv.tag.ciphertext",
      codeIssuedAt: new Date(),
      codeIssuedById: "superadmin_1",
    }),
  );
  fake.db.state.subscriptions.set("org_1", {
    organizationId: "org_1",
    seats: 5,
    status: "ACTIVE",
    billingMode: "PAID",
    currentPeriodEnd: new Date("2027-03-01T00:00:00.000Z"),
  });
});

describe("toCustomerOrder", () => {
  it("keeps what the billing screens show and drops the code and who handled it", () => {
    const row = fake.db.state.paymentOrders.get("order_1")!;
    const view = toCustomerOrder(row);

    expectNothingSecret(view, issued.hash);
    expect(view).toMatchObject({
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      userCount: row.userCount,
      payablePaise: row.payablePaise,
      transactionRef: row.transactionRef,
      hasIssuedCode: true,
    });
    expect(toCustomerOrder({ ...row, issuedCodeHash: null }).hasIssuedCode).toBe(false);
  });
});

describe("the organisation's order endpoints never return the issued code", () => {
  it("GET /api/billing/orders (listOrdersForOrg)", async () => {
    const list = await orders.listOrdersForOrg(ctx);
    expect(list).toHaveLength(1);
    expectNothingSecret(list, issued.hash);
  });

  it("the order page (getOrderForOrg)", async () => {
    const view = await orders.getOrderForOrg(ctx, "order_1");
    expectNothingSecret(view, issued.hash);
    expect(view.order.hasIssuedCode).toBe(true);
  });

  it("POST submit with a reference (submitReference)", async () => {
    fake.db.state.paymentOrders.set(
      "order_1",
      { ...fake.db.state.paymentOrders.get("order_1")!, status: "INITIATED", transactionRef: null },
    );
    const order = await orders.submitReference(ctx, "order_1", { reference: "UTR998877" });
    expectNothingSecret(order, issued.hash);
    expect(order.status).toBe("AWAITING_CONFIRMATION");
  });

  it("POST submit with the issued code, which approves (submitConfirmationCode)", async () => {
    const order = await orders.submitConfirmationCode(ctx, "order_1", issued.plaintext);
    expect(order.status).toBe("APPROVED");
    expectNothingSecret(order, issued.hash);
  });
});

describe("no customer-facing order function is typed to return the raw row", () => {
  const source = readFileSync(path.resolve("src/services/billing/orders.ts"), "utf8");

  it("every exported function taking the caller's context returns a CustomerOrder shape", () => {
    const signatures = [...source.matchAll(/export async function (\w+)\(\s*ctx: AuthContext[\s\S]*?\)\s*:\s*([^{]+)\{/g)];
    expect(signatures.length).toBeGreaterThan(5);
    for (const [, name, returns] of signatures) {
      expect(returns, `${name} returns ${returns}`).not.toMatch(/PaymentOrder\b/);
    }
    expect(source).toMatch(/order: CustomerOrder;/);
  });
});
