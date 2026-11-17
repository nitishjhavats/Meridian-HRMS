import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/auth/context";

import { createFakeBillingDb, orderRow } from "./fakeBillingDb.testkit";

/**
 * Two requests on one payment order, interleaved on purpose.
 *
 * Every transition is decided on a row read a moment earlier. These tests
 * hold one request between its read and its write -- at the bcrypt compare,
 * or at the settings read that follows the order read -- let the other one
 * finish, and then let the first carry on with what it read. Before every
 * order write became a compare-and-set (`orderWrite.ts`), the late request
 * wrote over the early one: the issued code typed in two tabs credited the
 * seats twice, and a stale resubmission, "ask for more information" or reject
 * reopened an order that had just been approved.
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
vi.mock("@/lib/auth/password", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/password")>()),
  verifyCode: vi.fn(async () => true),
}));

const orders = await import("./orders");
const { settleApproval } = await import("./approval");
const payments = await import("@/services/platform/payments");
const { writeAudit } = await import("@/lib/audit");
const { verifyCode } = await import("@/lib/auth/password");

const orgCtx = {
  userId: "user_owner",
  organizationId: "org_1",
  organization: { name: "Acme" },
  permissions: new Set(["org.billing.manage"]),
} as unknown as AuthContext;

const adminCtx = {
  userId: "superadmin_1",
  isSuperadmin: true,
  permissions: new Set(["platform.payment.approve"]),
} as unknown as AuthContext;

const approveInput = { actorUserId: "superadmin_1", mode: "BOTH" as const, via: "button" as const };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Holds the first settings read -- which every order function makes right
 * after it has read the order -- until `release` is called. `reached` resolves
 * once a request is parked there.
 */
function holdFirstSettingsRead() {
  const reached = deferred();
  const release = deferred();
  const settings = fake.db.prisma.platformSetting;
  const original = settings.findUnique.bind(settings);
  let held = false;
  settings.findUnique = async () => {
    if (!held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return original();
  };
  return { reached: reached.promise, release: release.resolve };
}

function seed(overrides: Parameters<typeof orderRow>[0] = {}) {
  fake.db = createFakeBillingDb();
  fake.db.state.platformSetting = {
    id: "singleton",
    paymentUpiId: "payee@example",
    paymentPayeeName: "HRMS Platform",
    paymentWindowMinutes: 240,
    confirmationMode: "BOTH",
  };
  const order = orderRow(overrides);
  fake.db.state.paymentOrders.set(order.id, order);
  fake.db.state.subscriptions.set(order.organizationId, {
    organizationId: order.organizationId,
    seats: 5,
    status: "ACTIVE",
    billingMode: "PAID",
    currentPeriodEnd: new Date("2027-03-01T00:00:00.000Z"),
  });
  return order;
}

const approvals = () =>
  vi.mocked(writeAudit).mock.calls.filter(([, entry]) => entry.action === "payment.approved").length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyCode).mockImplementation(async () => true);
});

describe("the issued code typed in two tabs", () => {
  it("credits the seats once", async () => {
    seed({
      status: "AWAITING_CONFIRMATION",
      issuedCodeHash: "hash-of-the-issued-code",
      codeIssuedById: "superadmin_1",
      codeIssuedAt: new Date(),
    });
    // Tab A reads the order and is held; tab B runs to the end; then A
    // carries on with what it read.
    const hold = holdFirstSettingsRead();
    const tabA = orders.submitConfirmationCode(orgCtx, "order_1", "123456");
    await hold.reached;
    const second = await orders.submitConfirmationCode(orgCtx, "order_1", "123456");
    hold.release();
    const first = await tabA;

    expect(second.status).toBe("APPROVED");
    expect(first.status).toBe("APPROVED");
    expect(fake.db.state.paymentOrders.get("order_1")?.status).toBe("APPROVED");
    expect(fake.db.state.subscriptionHistory).toHaveLength(1);
    expect(fake.db.state.paymentOrderEvents.filter((e) => e.toStatus === "APPROVED")).toHaveLength(1);
    expect(approvals()).toBe(1);
  });
});

describe("guesses at an issued code", () => {
  it("are capped even when sent in parallel", async () => {
    seed({
      status: "AWAITING_CONFIRMATION",
      issuedCodeHash: "hash-of-the-issued-code",
      codeIssuedById: "superadmin_1",
      codeAttemptCount: 4,
    });
    vi.mocked(verifyCode).mockImplementation(async () => false);
    // Both guesses read four attempts used; only one may be compared.
    const hold = holdFirstSettingsRead();
    const guessA = orders.submitConfirmationCode(orgCtx, "order_1", "111111");
    await hold.reached;
    await expect(orders.submitConfirmationCode(orgCtx, "order_1", "222222")).rejects.toThrow();
    hold.release();
    await expect(guessA).rejects.toThrow();

    expect(verifyCode).toHaveBeenCalledTimes(1);
    expect(fake.db.state.paymentOrders.get("order_1")?.codeAttemptCount).toBe(5);
  });

  it("stop being compared at all once the cap is reached", async () => {
    seed({ status: "AWAITING_CONFIRMATION", issuedCodeHash: "hash", codeIssuedById: "superadmin_1", codeAttemptCount: 5 });
    await expect(orders.submitConfirmationCode(orgCtx, "order_1", "123456")).rejects.toThrow();
    expect(fake.db.state.paymentOrders.get("order_1")?.codeAttemptCount).toBe(5);
    expect(verifyCode).not.toHaveBeenCalled();
    expect(fake.db.state.paymentOrders.get("order_1")?.status).toBe("AWAITING_CONFIRMATION");
  });
});

describe("a request decided on a stale read cannot reopen an approved order", () => {
  it("the organisation's resubmission", async () => {
    seed({ status: "INFO_REQUESTED", infoRequestNote: "Which bank?", transactionRef: "UTR111111" });
    const hold = holdFirstSettingsRead();

    const resubmit = orders.submitReference(orgCtx, "order_1", { reference: "UTR222222" });
    await hold.reached;
    await settleApproval(adminCtx, fake.db.state.paymentOrders.get("order_1")!, approveInput);
    hold.release();
    const answer = await resubmit;

    expect(answer.status).toBe("APPROVED");
    expect(fake.db.state.paymentOrders.get("order_1")?.status).toBe("APPROVED");
    expect(fake.db.state.paymentOrders.get("order_1")?.transactionRef).toBe("UTR111111");
    expect(fake.db.state.subscriptionHistory).toHaveLength(1);
  });

  it("the platform asking for more information", async () => {
    seed({ status: "AWAITING_CONFIRMATION" });
    const hold = holdFirstSettingsRead();

    const ask = payments.requestMoreInfo(adminCtx, "order_1", "Which bank?");
    await hold.reached;
    await settleApproval(adminCtx, fake.db.state.paymentOrders.get("order_1")!, approveInput);
    hold.release();

    await expect(ask).rejects.toThrow(/changed/);
    expect(fake.db.state.paymentOrders.get("order_1")?.status).toBe("APPROVED");
  });

  it("the platform rejecting it", async () => {
    seed({ status: "AWAITING_CONFIRMATION" });
    const hold = holdFirstSettingsRead();

    const reject = payments.rejectOrder(adminCtx, "order_1", "No such UTR");
    await hold.reached;
    await settleApproval(adminCtx, fake.db.state.paymentOrders.get("order_1")!, approveInput);
    hold.release();

    await expect(reject).rejects.toThrow(/changed/);
    expect(fake.db.state.paymentOrders.get("order_1")?.status).toBe("APPROVED");
  });
});
