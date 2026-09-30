import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDate } from "@/lib/utils";
import { holidayAnnouncement, shouldAnnounceHoliday } from "./holidayAnnouncement";

/**
 * A holiday that tells nobody is a day half the office comes in.
 *
 * The catalogue toggle has announced since it was built. A holiday typed in by
 * hand on the calendar screen did not — which left the local festival, the one
 * holiday no catalogue carries, as the only kind an organisation could add in
 * silence. Both paths build their words here now.
 */

describe("what the announcement says", () => {
  it("names the day and says the office is closed", () => {
    // The date is written by `formatDate`, the one formatter this product uses
    // for a day, rather than spelled out here: a test that hard-codes a month
    // abbreviation fails when ICU changes its mind about "Sep" and "Sept".
    const when = formatDate("2026-09-14");
    const draft = holidayAnnouncement({ name: "Ganesh Chaturthi", date: "2026-09-14" });
    expect(draft.title).toBe(`Ganesh Chaturthi — ${when}`);
    expect(draft.body).toBe(`Ganesh Chaturthi falls on ${when} and the office will be closed.`);
  });

  it("does not say the office is closed when it is not", () => {
    // `buildPeriodCalendar` reads `optional` and not `type`, so an optional
    // holiday is a day people may take and not one the office shuts for.
    // Announcing a closure would contradict the calendar it announces.
    const draft = holidayAnnouncement({ name: "Raksha Bandhan", date: "2026-08-28", optional: true });
    expect(draft.body).not.toContain("will be closed");
    expect(draft.body).toContain("optional holiday");
    expect(draft.body).toContain(formatDate("2026-08-28"));
  });

  it("keeps the lunar caveat, word for word", () => {
    const draft = holidayAnnouncement({ name: "Diwali", date: "2026-11-08", verify: true });
    expect(draft.body).toContain("the office will be closed.");
    expect(draft.body).toContain(
      "This date follows the lunar calendar, so it will be confirmed nearer the time.",
    );
  });

  it("carries the caveat on an optional holiday too", () => {
    const draft = holidayAnnouncement({
      name: "Chhath Puja",
      date: "2026-11-15",
      optional: true,
      verify: true,
    });
    expect(draft.body).toContain("optional holiday");
    expect(draft.body).toContain("lunar calendar");
  });
});

describe("whether this write is news", () => {
  it("announces a new holiday for a day still to come", () => {
    expect(shouldAnnounceHoliday({ created: true, date: "2026-09-14", today: "2026-09-09" })).toBe(true);
  });

  it("announces one added on the day itself", () => {
    expect(shouldAnnounceHoliday({ created: true, date: "2026-09-09", today: "2026-09-09" })).toBe(true);
  });

  it("says nothing when the row already existed", () => {
    // The catalogue's upsert is a no-op when somebody typed the same holiday in
    // by hand, or switched it on before. Announcing anyway was the second time
    // everybody heard about the same day.
    expect(shouldAnnounceHoliday({ created: false, date: "2026-09-14", today: "2026-09-09" })).toBe(false);
  });

  it("says nothing about a day that has gone", () => {
    // Holidays get back-filled so that a closed month counts its payable days
    // correctly. "The office will be closed" about last month can only confuse.
    expect(shouldAnnounceHoliday({ created: true, date: "2026-08-15", today: "2026-09-09" })).toBe(false);
  });
});

/**
 * Pure functions pin nothing if their callers stop consulting them. These read
 * the two services' source: the whole point of this round was that the two
 * holiday paths announce through the same code.
 */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CALENDAR = readFileSync(path.resolve("src/services/org/calendar.ts"), "utf8");
const CATALOGUE = readFileSync(path.resolve("src/services/org/holidayCatalogue.ts"), "utf8");

describe("both holiday paths announce through the same code", () => {
  it("has the calendar screen announce a holiday it created", () => {
    expect(strip(CALENDAR)).toMatch(/await announceHoliday\(ctx, \{\s*created: !input\.id,/);
  });

  it("has the catalogue call the calendar's function rather than its own", () => {
    expect(strip(CATALOGUE)).toContain('import { announceHoliday } from "@/services/org/calendar"');
    expect(strip(CATALOGUE)).toMatch(/await announceHoliday\(ctx, \{\s*created: !alreadyOnCalendar,/);
  });

  it("leaves no second copy of the wording in the catalogue", () => {
    expect(strip(CATALOGUE)).not.toContain("will be closed");
    expect(strip(CATALOGUE)).not.toContain("lunar calendar");
  });

  it("asks this module for the words and the decision", () => {
    expect(CALENDAR).toContain(
      'import { holidayAnnouncement, shouldAnnounceHoliday } from "@/domain/org/holidayAnnouncement"',
    );
    expect(strip(CALENDAR)).toMatch(/if \(!shouldAnnounceHoliday\(\{[\s\S]{0,120}\}\)\) return;/);
    expect(strip(CALENDAR)).toMatch(/const \{ title, body \} = holidayAnnouncement\(\{/);
  });

  it("keeps the announcement best effort, and behind the module and the permission", () => {
    // A holiday that is already created and already correct must not be undone
    // because the feed is switched off or this administrator may not post.
    expect(strip(CALENDAR)).toContain(
      'if (!ctx.modules.has("announcements") || !hasPermission(ctx, "announcement.create")) return;',
    );
    expect(strip(CALENDAR)).toMatch(/createAnnouncement\(ctx, \{ title, body, published: true \}\)\.catch\(\(\) => undefined\)/);
  });
});
