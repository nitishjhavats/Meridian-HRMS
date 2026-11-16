import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Nothing personal, and no working login, in the source tree.
 *
 * This code is also published. It carried a real person's UPI id as the
 * default payee -- in the Prisma default, the settings fallback, the seed, a
 * test and the billing doc -- so a fresh install would send its customers'
 * money to that person, and every reader learned the number behind it. The
 * README listed the seed logins, superadmin included, next to a fallback
 * password the seed used whenever none was set.
 *
 * The payee now comes from the platform settings row (set in Platform ->
 * Settings) or `PAYMENT_UPI_ID`, and an unconfigured platform refuses to take
 * orders instead of pointing them at somebody. `prisma/migrations` is not
 * scanned: in the source repository applied migrations are history and are
 * never edited, and the default the database applies today is set by the
 * newest migration that touches it. (This published copy runs no database, so
 * its init migration was neutralised as well.)
 */

const ROOTS = ["src", "docs", "prisma/schema.prisma", "prisma/seed.ts", "README.md", ".env.example"];
const SKIP_DIRS = new Set(["node_modules", ".next", "migrations"]);
const TEXT = /\.(ts|tsx|mts|mjs|js|json|md|prisma|sql|example|txt|html|css|ya?ml)$/;

function files(entry: string): string[] {
  const full = path.resolve(entry);
  const stat = statSync(full, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [entry];
  return readdirSync(full).flatMap((name) =>
    SKIP_DIRS.has(name) ? [] : files(path.join(entry, name)),
  );
}

const tree = ROOTS.flatMap(files).filter((f) => TEXT.test(f) || f.endsWith(".env.example"));

/** An Indian mobile number used as a UPI handle: `9xxxxxxxxx@bank`. */
const PHONE_VPA = /\b[6-9]\d{9}@[a-z][a-z0-9.]*/i;

/**
 * Reading every file of the tree, and importing the orders module afresh, take
 * a second or two alone and longer under a full parallel run; the default 5 s
 * was too close to that to be a fair limit.
 */
const SLOW = { timeout: 30_000 };

describe("no personal payee anywhere in the tree", SLOW, () => {
  it("scans a real tree", () => {
    expect(tree.length).toBeGreaterThan(100);
  });

  it("no file holds a phone-number UPI id", () => {
    // Only the file names are reported, so a failure never prints the number.
    const offenders = tree.filter((file) => PHONE_VPA.test(readFileSync(path.resolve(file), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("no default login is published", () => {
  it("the README does not list seed logins or passwords", () => {
    const readme = readFileSync(path.resolve("README.md"), "utf8");
    expect(readme).not.toMatch(/Password@123|ChangeMe@/);
    expect(readme).not.toMatch(/### Demo logins/);
  });

  it("the seed refuses to invent a superadmin password", () => {
    const seed = readFileSync(path.resolve("prisma/seed.ts"), "utf8");
    expect(seed).not.toMatch(/ChangeMe@/);
    expect(seed).toMatch(/SUPERADMIN_PASSWORD/);
  });

  it(".env.example names the superadmin password without giving one", () => {
    const example = readFileSync(path.resolve(".env.example"), "utf8");
    expect(example).toMatch(/^SUPERADMIN_PASSWORD=""\r?$/m);
  });
});

describe("the payee comes from settings or the environment, never a literal", SLOW, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@/lib/db/prisma");
  });

  async function pricingWith(row: Record<string, unknown> | null) {
    vi.resetModules();
    vi.doMock("@/lib/db/prisma", () => ({
      prisma: { platformSetting: { findUnique: async () => row } },
    }));
    const { getPlatformPricing } = await import("@/services/billing/orders");
    return getPlatformPricing();
  }

  it("uses the settings row when it has one", async () => {
    vi.stubEnv("PAYMENT_UPI_ID", "env-payee@bank");
    expect((await pricingWith({ paymentUpiId: "row-payee@bank" })).upiId).toBe("row-payee@bank");
  });

  it("falls back to PAYMENT_UPI_ID when the row has none", async () => {
    vi.stubEnv("PAYMENT_UPI_ID", "env-payee@bank");
    expect((await pricingWith(null)).upiId).toBe("env-payee@bank");
    expect((await pricingWith({ paymentUpiId: "" })).upiId).toBe("env-payee@bank");
  });

  it("is empty, not somebody's account, when neither is set", async () => {
    vi.stubEnv("PAYMENT_UPI_ID", "");
    expect((await pricingWith(null)).upiId).toBe("");
  });

  it("and an unconfigured payee stops a new order before it is created", () => {
    const source = readFileSync(path.resolve("src/services/billing/orders.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function createOrder"));
    const guard = body.indexOf("if (!pricing.upiId)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("createWithOrderNumber("));
  });
});
