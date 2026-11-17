import type { PaymentOrder } from "@prisma/client";

/**
 * An in-memory stand-in for the handful of Prisma calls the billing services
 * make, so the real `settleApproval` and the real order functions can be run
 * in a unit test without a database.
 *
 * Deliberately small and strict: a filter it does not understand throws
 * instead of quietly matching, so a test can never pass because the fake was
 * too generous. Writes land on the shared state at once, which is how two
 * requests see each other's committed work. Inside `$transaction` every write
 * also records how to undo itself, and a callback that throws undoes its own
 * writes. There are no row locks and no isolation: a rollback restores the
 * values its own writes replaced, so a test must not have two requests write
 * the same row while one of them is about to roll back.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Undo = (() => void)[] | null;

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
      const op = want as { lt?: unknown };
      if (Object.keys(op).length === 1 && typeof op.lt === "number") {
        return typeof have === "number" && have < op.lt;
      }
      throw new Error(`fake billing db: unsupported filter on "${key}"`);
    }
    return have === want;
  });
}

function applyData<T extends Row>(row: T, data: Row): T {
  const next: Row = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue; // Prisma: undefined leaves the column alone
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
  // Strictly later than the row's last write, as Postgres clock time would be.
  const previous = row.updatedAt instanceof Date ? row.updatedAt.getTime() : 0;
  next.updatedAt = new Date(Math.max(Date.now(), previous + 1));
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

  function setIn<K, V>(map: Map<K, V>, key: K, value: V, undo: Undo) {
    if (undo) {
      const had = map.has(key);
      const before = map.get(key);
      undo.push(() => (had ? map.set(key, before as V) : map.delete(key)));
    }
    map.set(key, value);
  }

  function pushTo(list: Row[], row: Row, undo: Undo) {
    list.push(row);
    if (undo) undo.push(() => list.splice(list.indexOf(row), 1));
  }

  function makeClient(undo: Undo) {
    const orders = () => [...state.paymentOrders.values()];
    const client = {
      paymentOrder: {
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
          setIn(state.paymentOrders, where.id, next, undo);
          return next;
        },
        async updateMany({ where, data }: { where: Where; data: Row }) {
          let count = 0;
          for (const row of orders()) {
            if (!matches(row as unknown as Row, where)) continue;
            setIn(state.paymentOrders, row.id, applyData(row as unknown as Row, data) as unknown as PaymentOrder, undo);
            count += 1;
          }
          return { count };
        },
      },
      subscription: {
        async findUnique({ where }: { where: { organizationId: string } }) {
          return state.subscriptions.get(where.organizationId) ?? null;
        },
        async update({ where, data }: { where: { organizationId: string }; data: Row }) {
          const row = state.subscriptions.get(where.organizationId);
          if (!row) throw new Error("fake billing db: subscription not found");
          const next = applyData(row, data);
          setIn(state.subscriptions, where.organizationId, next, undo);
          return next;
        },
        async updateMany({ where, data }: { where: Where; data: Row }) {
          let count = 0;
          for (const [key, row] of state.subscriptions) {
            if (!matches(row, where)) continue;
            setIn(state.subscriptions, key, applyData(row, data), undo);
            count += 1;
          }
          return { count };
        },
        async create({ data }: { data: Row }) {
          const key = String(data.organizationId);
          if (state.subscriptions.has(key)) throw new Error("fake billing db: unique organizationId");
          const row = { ...data, updatedAt: new Date() };
          setIn(state.subscriptions, key, row, undo);
          return row;
        },
      },
      organization: {
        async update({ where, data }: { where: { id: string }; data: Row }) {
          const next = applyData(state.organizations.get(where.id) ?? { id: where.id }, data);
          setIn(state.organizations, where.id, next, undo);
          return next;
        },
      },
      subscriptionHistory: {
        async create({ data }: { data: Row }) {
          pushTo(state.subscriptionHistory, { ...data }, undo);
          return data;
        },
      },
      paymentOrderEvent: {
        async create({ data }: { data: Row }) {
          pushTo(state.paymentOrderEvents, { ...data }, undo);
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
        const own: (() => void)[] = [];
        try {
          return await callback(makeClient(own));
        } catch (error) {
          for (const step of own.reverse()) step();
          throw error;
        }
      },
    };
    return client;
  }

  const prisma = makeClient(null);
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
