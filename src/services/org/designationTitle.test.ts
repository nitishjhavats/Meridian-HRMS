import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A designation's title is unique per organisation. `saveDepartment` has
 * always said so before writing; `saveDesignation` did not, so "Manager" typed
 * a second time -- or an inline rename onto a title already in the list -- hit
 * the index and came back as "something went wrong on our side" with a
 * reference number.
 */

const STRUCTURE = "src/services/org/structure.ts";
const SCHEMA = "prisma/schema.prisma";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("saveDesignation and a title already in use", () => {
  const block = bodyOf(STRUCTURE, "export async function saveDesignation");

  it("is guarding a real index", () => {
    const schema = readFileSync(path.resolve(SCHEMA), "utf8");
    const model = schema.slice(schema.indexOf("model Designation {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/@@unique\(\[organizationId, title\]\)/);
  });

  it("looks for the clash before writing, leaving the row being renamed out", () => {
    expect(block).toMatch(
      /prisma\.designation\.findFirst\(\{\s*where: \{ organizationId: ctx\.organizationId!, title, \.\.\.\(input\.id \? \{ NOT: \{ id: input\.id \} \} : \{\}\) \}/,
    );
    expect(block).toMatch(/new ConflictError\(`There is already a designation called \$\{title\}\.`\)/);
  });

  it("and says the same thing when two saves race past the check", () => {
    expect(block).toMatch(/isUniqueViolation\(error, "title"\)/);
  });
});
