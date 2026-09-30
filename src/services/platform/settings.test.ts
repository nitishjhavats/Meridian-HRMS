import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The invoice prefix on the platform settings.
 *
 * The settings form always sends it. Cleared, it went through `...patch` as
 * `""` and was saved -- the "when set" override beside the spread did not
 * fire for an empty string -- and from then on every order was numbered
 * `-2026-NNNN`, because `orders.ts` falls back for a missing prefix and not
 * for an empty one. Too short, the domain threw its plain Error out of the
 * middle of the update and the route answered with a 500.
 *
 * Cleared now means the default. The hint beside the box has always said so
 * ("Invoices are numbered BMG-..."), and clearing it is the only way back.
 */

const SETTINGS = "src/services/platform/settings.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("updateSettings and the invoice prefix", () => {
  const body = code(SETTINGS);

  it("takes the prefix out of the spread before writing", () => {
    expect(body).toMatch(/const \{ invoicePrefix: rawPrefix, \.\.\.rest \} = patch;/);
    expect(body).toMatch(/\.\.\.rest,/);
    expect(body).not.toMatch(/\.\.\.patch,/);
  });

  it("resets a blank one to the default rather than saving it or refusing it", () => {
    expect(body).toMatch(/const DEFAULT_INVOICE_PREFIX = "BMG";/);
    expect(body).toMatch(/if \(rawPrefix\.trim\(\) === ""\) \{\s*invoicePrefix = DEFAULT_INVOICE_PREFIX;/);
    expect(body).not.toMatch(/cannot be blank/);
  });

  it("agrees with the column's default and the fallback orders use", () => {
    const schema = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/invoicePrefix\s+String\s+@default\("BMG"\)/);
    expect(code("src/services/billing/orders.ts")).toMatch(/settings\?\.invoicePrefix \?\? "BMG"/);
  });

  it("turns the domain's refusal of anything else into the one the route can show", () => {
    expect(body).toMatch(/\} else \{\s*try \{\s*invoicePrefix = normaliseCodePrefix\(rawPrefix\);/);
    expect(body).toMatch(/error instanceof InvalidCodePrefix/);
    expect(body).toMatch(/new ValidationError\("The invoice prefix is three or four letters, A to Z\."\)/);
  });

  it("writes the normalised prefix only when one was sent", () => {
    expect(body).toMatch(/\.\.\.\(invoicePrefix !== undefined \? \{ invoicePrefix \} : \{\}\)/);
  });
});
