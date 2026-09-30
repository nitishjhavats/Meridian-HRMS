import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the route handler makes of two refusals that used to reach people as
 * something they were not.
 *
 * A zod rejection was "Please check the highlighted fields." with the fields in
 * `details.issues`, which almost no form read -- so nothing was highlighted.
 * And `InvalidCodePrefix` is a plain Error thrown by the domain, which the
 * handler treated as a crash: clearing the employee-code box on the platform
 * console, or typing a one-letter invoice prefix, was answered with a 500, a
 * stack in the log and "something went wrong on our side".
 *
 * The handler pulls in the session and the database, so these read the source
 * rather than call it; the sentence-building is tested for real in
 * `lib/fieldIssues.test.ts`.
 */

const HANDLER = "src/lib/http/handler.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the route handler's error mapping", () => {
  const body = code(HANDLER);

  it("names the first field in a zod refusal", () => {
    expect(body).toMatch(/fieldIssuesFrom\(error\.issues\)/);
    expect(body).toMatch(/new ValidationError\(describeIssues\(issues\), \{ issues \}\)/);
    expect(body).not.toMatch(/"Please check the highlighted fields\."/);
  });

  it("answers a bad code prefix as a validation error, not a crash", () => {
    expect(body).toMatch(/import \{ InvalidCodePrefix \} from "@\/domain\/employees\/code"/);
    expect(body).toMatch(
      /if \(error instanceof InvalidCodePrefix\) \{\s*error = new ValidationError\(error\.message\);/,
    );
  });

  it("does so before the unknown-error log line", () => {
    // Otherwise the stack would still be logged as a crash before being
    // answered as a refusal.
    const mapped = body.indexOf("error instanceof InvalidCodePrefix");
    const logged = body.indexOf("if (!(error instanceof AppError))");
    expect(mapped).toBeGreaterThan(-1);
    expect(mapped).toBeLessThan(logged);
  });
});
