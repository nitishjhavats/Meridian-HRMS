import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Nothing spins for ever.
 *
 * Seven screens fetched on mount with `.catch(() => null)` and left their
 * "Loading…" up for good when the answer was a 401, a 402, a 403 or a 500.
 * Each now keeps the error and renders `LoadFailed`, which says what happened
 * in a sentence and offers Retry only when trying again could change the
 * answer. Source assertions, because what is pinned is the shape of every
 * catch, not the behaviour of one.
 */

const STATES = "src/components/ui/states.tsx";

const SCREENS = [
  "src/app/(app)/employees/[id]/SalaryRevision.tsx",
  "src/components/attendance/MonthDetail.tsx",
  "src/app/(app)/payroll/rules/Statutory.tsx",
  "src/app/(app)/chat/ChatScreen.tsx",
  "src/app/(app)/billing/SeatPurchase.tsx",
  "src/app/(app)/settings/organisation/RenumberCodes.tsx",
  "src/app/(app)/settings/organisation/ReportingLines.tsx",
];

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("LoadFailed", () => {
  const body = code(STATES);

  it("is the shared error state, and reads the failure through describeLoadFailure", () => {
    expect(body).toMatch(/export function LoadFailed\(/);
    expect(body).toMatch(/import \{ describeLoadFailure \} from "@\/lib\/client\/loadFailure"/);
    expect(body).toMatch(/describeLoadFailure\(error, what\)/);
  });

  it("offers Retry only when a retry could change the answer", () => {
    expect(body).toMatch(/onRetry && !failure\.refused/);
    expect(body).toMatch(/Try again/);
  });

  it("shows the reference id when there is one to quote", () => {
    expect(body).toMatch(/failure\.correlationId/);
  });

  it("has an inline form for panels and dialogs and a block form for sections", () => {
    expect(body).toMatch(/compact\?: boolean/);
    expect(body).toMatch(/<ErrorState[\s\S]*?action=\{retry \?\? undefined\}/);
  });
});

describe("every mount-time fetch in the group", () => {
  for (const file of SCREENS) {
    const name = path.basename(file);

    it(`${name} no longer swallows a failed load`, () => {
      const body = code(file);
      // The two spellings that lost the error: a catch that maps it to null,
      // and a bare `catch {` that drops it on the floor.
      expect(body, "catch(() => null)").not.toMatch(/\.catch\(\(\) => (?:null|setData\(null\))\)/);
      expect(body, "bare catch").not.toMatch(/catch \{\n\s*set\w+\(null\);\n\s*\}/);
    });

    it(`${name} renders LoadFailed with a way to try again`, () => {
      const body = code(file);
      expect(body).toMatch(/import \{[^}]*\bLoadFailed\b[^}]*\} from "@\/components\/ui\/states"/);
      expect(body).toMatch(/<LoadFailed[\s\S]*?onRetry=\{/);
    });
  }
});
