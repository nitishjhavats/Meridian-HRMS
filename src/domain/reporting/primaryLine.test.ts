import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LIVE_PRIMARY_LINE } from "./primaryLine";

/**
 * The predicate is the partial index, or the two disagree about how many
 * managers somebody has.
 */
describe("LIVE_PRIMARY_LINE", () => {
  it("is the row the partial index keeps unique per employee", () => {
    expect(LIVE_PRIMARY_LINE).toEqual({ type: "PRIMARY", endDate: null });

    const migration = readFileSync(
      path.resolve("prisma/migrations/20260908024732_reporting_line_history/migration.sql"),
      "utf8",
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "ReportingRelationship_one_live_primary"\s+ON "ReportingRelationship" \("employeeId"\)\s+WHERE "endDate" IS NULL AND "type" = 'PRIMARY';/,
    );
  });
});
