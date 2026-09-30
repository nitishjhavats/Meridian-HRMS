import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A letter template's subject is unique per organisation, not only per letter
 * type: the schema carries `@@unique([organizationId, title])` beside the one
 * on category, and `saveFramework` checked only the category. So "Letter of
 * Employment" on the offer letter and again on the appointment letter hit the
 * index, and the second save was a 500 with nothing to say about subjects.
 */

const TEMPLATES = "src/services/letters/templates.ts";
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

describe("saveFramework and a subject another letter type uses", () => {
  const block = bodyOf(TEMPLATES, "export async function saveFramework");

  it("is guarding a real index", () => {
    const schema = readFileSync(path.resolve(SCHEMA), "utf8");
    const model = schema.slice(schema.indexOf("model LetterTemplate {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/@@unique\(\[organizationId, title\]\)/);
  });

  it("asks whether another category already has the subject", () => {
    expect(block).toMatch(
      /prisma\.letterTemplate\.findFirst\(\{\s*where: \{ organizationId: ctx\.organizationId!, title: subject, NOT: \{ category \} \}/,
    );
    expect(block).toMatch(/already uses the subject "\$\{subject\}"/);
  });

  it("names the letter type that has it", () => {
    // "Appointment letter already uses..." tells them where to look; a bare
    // "another letter type" would send them through all ten.
    expect(block).toMatch(/categoryLabel\(sameSubject\.category as LetterCategory\)/);
  });

  it("and answers a race on the index the same way", () => {
    expect(block).toMatch(/isUniqueViolation\(error, "title"\)/);
    expect(block).toMatch(/new ConflictError\(/);
  });
});
