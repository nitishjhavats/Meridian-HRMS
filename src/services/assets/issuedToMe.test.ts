import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Company property issued to you ... Please acknowledge it."
 *
 * The notification linked to `/assets`, which is the register and needs
 * `asset.manage` -- the person being handed the laptop does not hold it, so
 * the click landed on "You do not have access" and nobody could ever
 * acknowledge anything. The register's "Unacknowledged" count never came down
 * and the exit screen said "never acknowledged" about people who were never
 * given a way to.
 *
 * The card on the dashboard is the way now. These checks tie the three ends
 * together: the link the service sends, the anchor the card renders, and the
 * route the card posts to.
 */

const SERVICE = "src/services/assets/index.ts";
const CARD = "src/app/(app)/dashboard/MyAssets.tsx";
const PAGE = "src/app/(app)/dashboard/page.tsx";
const ROUTE = "src/app/api/assets/[id]/route.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("the notification lands on the card", () => {
  const service = code(SERVICE);
  const link = /export const MY_ASSETS_LINK = "([^"]+)"/.exec(service)?.[1];

  it("names one link and sends it", () => {
    expect(link).toBe("/dashboard#my-assets");
    expect(fn(service, "issueAsset")).toMatch(/link: MY_ASSETS_LINK/);
    expect(service).not.toMatch(/link: "\/assets"/);
  });

  it("the card carries that anchor", () => {
    const anchor = link!.split("#")[1];
    expect(code(CARD)).toMatch(new RegExp(`id="${anchor}"`));
  });

  it("the dashboard renders it for an employee with the module on", () => {
    const page = code(PAGE);
    expect(page).toMatch(/ctx\.employeeId && ctx\.modules\.has\("assets"\) \? assetsIssuedToMe\(ctx\)/);
    expect(page).toMatch(/<MyAssets initial=\{myAssets\} \/>/);
  });
});

describe("acknowledging reuses the register's route", () => {
  it("the card posts the existing action, keyed on the asset", () => {
    const card = code(CARD);
    expect(card).toMatch(/api\(`\/api\/assets\/\$\{row\.assetId\}`/);
    expect(card).toMatch(/action: "acknowledge", assignmentId: row\.assignmentId/);
    expect(code(ROUTE)).toMatch(/action: z\.literal\("acknowledge"\), assignmentId/);
  });

  it("the service reads only the caller's own assignments", () => {
    const service = code(SERVICE);
    const mine = fn(service, "assetsIssuedToMe");
    expect(mine).toMatch(/requireModule\(ctx, "assets"\)/);
    expect(mine).toMatch(/if \(!ctx\.employeeId\) return \[\]/);
    expect(mine).toMatch(/employeeId: ctx\.employeeId, returnedOn: null/);
    // No `asset.manage` here: this is the employee's own record.
    expect(mine).not.toMatch(/asset\.manage/);
  });

  it("and the acknowledge is a write like the others", () => {
    const ack = fn(code(SERVICE), "acknowledgeAssignment");
    expect(ack).toMatch(/requireModule\(ctx, "assets"\)/);
    expect(ack).toMatch(/requireWritable\(ctx\)/);
    expect(ack).toMatch(/employeeId: ctx\.employeeId \?\? ""/);
  });
});
