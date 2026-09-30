import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "My letters" is the reader's own letters, whoever the reader is.
 *
 * `listLetters(ctx)` narrows to own-and-issued only for somebody who holds
 * nothing but `letter.read.self`. HR, an admin and the owner all hold
 * `letter.read.all`, so for them the unfiltered call answered with the whole
 * register -- every employee's drafts and revocations included, each with a
 * PDF link -- under a heading that said "Issued to you".
 */

const PAGE = "src/app/(app)/me/letters/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/me/letters", () => {
  it("asks for the reader's own issued letters by name", () => {
    const body = code(PAGE);
    expect(body).toMatch(
      /listLetters\(ctx,\s*\{\s*employeeId:\s*ctx\.employeeId,\s*status:\s*"ISSUED"\s*\}\)/,
    );
  });

  it("never relies on the service narrowing on its own", () => {
    // The bug in one expression.
    expect(code(PAGE)).not.toMatch(/listLetters\(ctx\)/);
  });
});
