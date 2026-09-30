import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * An organisation id that names nothing is a 404 with a way back.
 *
 * Two halves. The page turns the service's `NotFoundError` into the
 * framework's 404 (`asNotFound`), which it has done since the dead-session
 * round. But nothing under the console caught that 404, so it fell through to
 * the root not-found: no shell, "Go to the dashboard" and "Sign in" as the
 * only ways on, for a platform owner who was one click from the list. The
 * not-found beside the page renders inside the console and links to it.
 */

const DIR = "src/app/(platform)/platform/organisations/[id]";
const PAGE = `${DIR}/page.tsx`;
const NOT_FOUND = `${DIR}/not-found.tsx`;

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the organisation detail page", () => {
  it("turns an unknown id into a 404, not a fault", () => {
    const page = code(PAGE);
    expect(page).toMatch(/getOrganization\(ctx, id\)\.catch\(asNotFound\)/);
    expect(page).toMatch(/listOrganizationPeople\(ctx, id, \{[^}]*\}\)\.catch\(asNotFound\)/);
  });

  it("has a not-found screen beside it that leads back to the list", () => {
    expect(existsSync(path.resolve(NOT_FOUND)), "no not-found.tsx beside the page").toBe(true);
    const screen = code(NOT_FOUND);
    expect(screen).toMatch(/href="\/platform\/organisations"/);
    // `verify-sweep` tells an intentional 404 from a dead link by this marker.
    expect(screen).toMatch(/data-notfound="/);
  });
});
