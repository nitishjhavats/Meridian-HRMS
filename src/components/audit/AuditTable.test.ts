import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { displayValue } from "./AuditTable";

/**
 * The "Changed" column must be able to say what changed.
 *
 * It rendered each side with `String(...)`, which is fine for a name or a
 * number and prints "[object Object]" for anything nested. Giving somebody
 * login credentials writes `{ login: { role, email } }`, so the one row an
 * administrator opens the audit log to check read "login: — → [object Object]".
 */

const TABLE = "src/components/audit/AuditTable.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("displayValue", () => {
  it("shows a nested value as its JSON, not as [object Object]", () => {
    expect(displayValue({ login: { role: "EMPLOYEE", email: "a@b.c" } })).toBe(
      '{"login":{"role":"EMPLOYEE","email":"a@b.c"}}',
    );
    expect(displayValue(["TRAVEL", "MEALS"])).toBe('["TRAVEL","MEALS"]');
    expect(displayValue({})).not.toContain("[object");
  });

  it("keeps primitives as they were, including the falsy ones", () => {
    expect(displayValue("Priya")).toBe("Priya");
    expect(displayValue(42)).toBe("42");
    expect(displayValue(false)).toBe("false");
    expect(displayValue(0)).toBe("0");
  });

  it("uses the dash only for a missing side", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue(undefined)).toBe("—");
  });

  it("cuts a long payload short so it cannot widen the column", () => {
    const long = displayValue({ note: "x".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
    expect(displayValue({ a: 1 }, 80)).toBe('{"a":1}');
  });

  it("writes a Date as its ISO string rather than a quoted one", () => {
    expect(displayValue(new Date("2026-09-16T00:00:00.000Z"))).toBe("2026-09-16T00:00:00.000Z");
  });
});

describe("the table", () => {
  const body = code(TABLE);

  it("renders both sides through displayValue and never through String()", () => {
    expect(body).toMatch(/\{displayValue\(c\.before\)\}/);
    expect(body).toMatch(/\{displayValue\(c\.after\)\}/);
    expect(body).not.toMatch(/String\(c\.(before|after)/);
  });
});
