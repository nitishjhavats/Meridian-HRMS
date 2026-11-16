import type { PaymentOrder } from "@prisma/client";

/**
 * An in-memory stand-in for the handful of Prisma calls the billing services
 * make, so the real `settleApproval` and the real order functions can be run
 * in a unit test without a database.
 *
 * Deliberately small and strict: a filter it does not understand throws
 * instead of quietly matching, so a test can never pass because the fake was
 * too generous. Writes land on the shared state at once, which is how two
 * requests see each other's committed work; `$transaction` restores a
 * snapshot if its callback throws, which is how a rolled-back transaction
 * leaves nothing behind.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export interface FakeBillingState {
  paymentOrders: Map<string, PaymentOrder>;
  subscriptions: Map<string, Row>;
  organizations: Map<string, Row>;
  subscriptionHistory: Row[];
  paymentOrderEvents: Row[];
  platformSetting: Row | null;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "NOT") return !matches(row, want as Where);
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want !== null && typeof want === "object") {
      throw new Error(`fake billing db: unsupported filter on "${key}"`);
    }
    return have === want;
  });
}

function applyData<T extends Row>(row: T, data: Row): T {
  const next: Row = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const op = value as { increment?: number };
      if (typeof op.increment === "number") {
        next[key] = (Number(next[key]) || 0) + op.increment;
        continue;
      }
      throw new Error(`fake billing db: unsupported update on "${key}"`);
    }
    next[key] = value;
  }
  next.updatedAt = new Date();
  return next as T;
}

export function createFakeBillingDb() {
  const state: FakeBillingState = {
    paymentOrders: new Map(),
    subscriptions: new Map(),
    organizations: new Map(),
    subscriptionHistory: [],
    paymentOrderEvents: [],
    platformSetting: null,
  };

  const orders = () => [...state.paymentOrders.values()];

  const paymentOrder = {
    async findFirst({ where }: { where: Where }) {
      return orders().find((o) => matches(o as unknown as Row, where)) ?? null;
    },
    async findMany({ where }: { where: Where }) {
      return orders().filter((o) => matches(o as unknown as Row, where));
    },
    async findUnique({ where }: { where: { id: string } }) {
      return state.paymentOrders.get(where.id) ?? null;
    },
    async findUniqueOrThrow({ where }: { where: { id: string } }) {
      const row = state.paymentOrders.get(where.id);
      if (!row) throw new Error("fake billing db: order not found");
      return row;
    },
    async count({ where }: { where: Where }) {
      return orders().filter((o) => matches(o as unknown as Row, where)).length;
    },
    async update({ where, data }: { where: { id: string }; data: Row }) {
      const row = state.paymentOrders.get(where.id);
      if (!row) throw new Error("fake billing db: order not found");
      const next = applyData(row as unknown as Row, data) as unknown as PaymentOrder;
      state.paymentOrders.set(where.id, next);
      return next;
    },
    async updateMany({ where, data }: { where: Where; data: Row }) {
      let count = 0;
      for (const row of orders()) {
        if (!matches(row as unknown as Row, where)) continue;
        state.paymentOrders.set(row.id, applyData(row as unknown as Row, data) as unknown as PaymentOrder);
        count += 1;
      }
      return { count };
    },
  };

  const subscription = {
    async findUnique({ where }: { where: { organizationId: string } }) {
      return state.subscriptions.get(where.organizationId) ?? null;
    },
    async update({ where, data }: { where: { organizationId: string }; data: Row }) {
      const row = state.subscriptions.get(where.organizationId);
      if (!row) throw new Error("fake billing db: subscription not found");
      const next = applyData(row, data);
      state.subscriptions.set(where.organizationId, next);
      return next;
    },
    async create({ data }: { data: Row }) {
      const row = { ...data };
      state.subscriptions.set(String(data.organizationId), row);
      return row;
    },
  };

  const prisma = {
    paymentOrder,
    subscription,
    organization: {
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const next = applyData(state.organizations.get(where.id) ?? { id: where.id }, data);
        state.organizations.set(where.id, next);
        return next;
      },
    },
    subscriptionHistory: {
      async create({ data }: { data: Row }) {
        state.subscriptionHistory.push({ ...data });
        return data;
      },
    },
    paymentOrderEvent: {
      async create({ data }: { data: Row }) {
        state.paymentOrderEvents.push({ ...data });
        return data;
      },
    },
    paymentCode: {
      async findUnique() {
        return null;
      },
      async findFirst() {
        return null;
      },
    },
    couponRedemption: {
      async count() {
        return 0;
      },
    },
    platformSetting: {
      async findUnique() {
        return state.platformSetting;
      },
    },
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const snapshot = {
        paymentOrders: new Map(state.paymentOrders),
        subscriptions: new Map(state.subscriptions),
        organizations: new Map(state.organizations),
        subscriptionHistory: [...state.subscriptionHistory],
        paymentOrderEvents: [...state.paymentOrderEvents],
      };
      try {
        return await callback(prisma);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };

  return { prisma, state };
}

/** A payment order row with every column filled, overridable per test. */
export function orderRow(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  const now = new Date();
  return {
    id: "order_1",
    organizationId: "org_1",
    orderNumber: "ORD-2026-0001",
    userCount: 10,
    pricePerUserPaise: 5_900,
    subtotalPaise: 59_000,
    discountPaise: 0,
    payablePaise: 59_000,
    couponId: null,
    couponCode: null,
    status: "AWAITING_CONFIRMATION",
    upiId: "payee@example",
    periodMonths: 12,
    confirmationCode: null,
    transactionRef: "UTR123456",
    payerNote: null,
    issuedCodeHash: null,
    issuedCodeCipher: null,
    codeIssuedAt: null,
    codeIssuedById: null,
    codeAttemptCount: 0,
    submittedAt: now,
    reviewedAt: null,
    reviewedById: null,
    reviewNote: null,
    infoRequestNote: null,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    windowMinutes: 240,
    previousSeats: 0,
    createdAt: now,
    updatedAt: now,
    createdById: "user_owner",
    ...overrides,
  };
}
