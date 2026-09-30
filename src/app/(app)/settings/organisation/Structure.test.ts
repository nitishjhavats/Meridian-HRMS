import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Placing a fence centre still refuses a rough reading, although a check-in
 * no longer does. The difference is what the refusal has to say: a rough
 * check-in is one mark with its accuracy on the record, a rough centre is
 * wrong for every mark after it. An administrator who has just read that old
 * phones are no longer turned away should not be told here that they are.
 */

const STRUCTURE = "src/app/(app)/settings/organisation/Structure.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("capturing a fence centre from the admin's phone", () => {
  const body = code(STRUCTURE);

  it("keeps its own accuracy budget", () => {
    expect(body).toMatch(/import \{ accuracyBudget \} from "@\/domain\/attendance\/geo";/);
    expect(body).toMatch(/const budget = accuracyBudget\(/);
    expect(body).toMatch(/if \(Math\.round\(accuracy\) > budget\)/);
  });

  it("says the centre needs the accuracy, and check-ins only if switched on", () => {
    expect(body).toMatch(/A fence centre needs a reading of ±\$\{budget\} m or better/);
    // "Check-ins are not held to this" was false for an organisation that had
    // switched "Require an accurate GPS fix" on.
    expect(body).not.toMatch(/Check-ins are not held to this/);
    expect(body).toMatch(
      /Check-ins are only held to a limit if you switch one on under Attendance rules; the centre always is\./,
    );
  });
});
