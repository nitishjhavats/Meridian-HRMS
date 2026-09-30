import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where a letter's signature comes from.
 *
 * There is no pure function to test here — the resolution is three `??` in two
 * files — so these read the source. That is the right shape for this particular
 * rule: the bug was never bad arithmetic, it was that the *only* place a
 * signature could live was one row per letter category, so uploading it once
 * reached one letter type out of ten and nine went out with a typed name over
 * blank paper.
 */

const TEMPLATES = readFileSync(path.resolve("src/services/letters/templates.ts"), "utf8");
const LETTERS = readFileSync(path.resolve("src/services/letters/index.ts"), "utf8");
const SCHEMA = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the organisation owns the signature, and a template may override it", () => {
  it("has somewhere organisation-wide to put one", () => {
    // The brace matters. `model Organization` also matches
    // `model OrganizationSlug`, which sits above it in the file, so without it
    // this asserted against the wrong block and failed for a reason that had
    // nothing to do with signatures.
    const org = SCHEMA.slice(SCHEMA.indexOf("model Organization {"));
    const body = org.slice(0, org.indexOf("\n}"));
    for (const column of ["signatureKey", "signatoryName", "signatoryTitle", "stampKey"]) {
      expect(body, column).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("falls back field by field rather than all or nothing", () => {
    // An organisation whose director signs everything but whose offer letters
    // are signed by HR overrides the *name* on one category and still uses the
    // same uploaded image. All-or-nothing would make them upload it twice.
    const code = strip(LETTERS);
    expect(code).toMatch(/signatoryName: row\?\.signatoryName \?\? org\?\.signatoryName/);
    expect(code).toMatch(/signatoryTitle: row\?\.signatoryTitle \?\? org\?\.signatoryTitle/);
    expect(code).toMatch(/signatureKey: row\?\.signatureKey \?\? org\?\.signatureKey/);
  });

  it("does the same on the screen that edits templates", () => {
    // Two different fallbacks — one for the PDF and one for the editor — would
    // mean the editor showing a signature the letter does not print.
    const code = strip(TEMPLATES);
    expect(code).toMatch(/const key = row\?\.signatureKey \?\? org\.signatureKey/);
    expect(code).toMatch(/name: row\?\.signatoryName \?\? org\.signatoryName/);
  });

  it("says when the signature is the organisation's rather than this letter's", () => {
    // Otherwise the editor looks empty for nine categories out of ten and
    // somebody uploads it ten times.
    expect(strip(TEMPLATES)).toMatch(/inherited: row\?\.signatureKey == null && org\.signatureKey != null/);
  });
});

describe("a letter can decline to be signed or stamped", () => {
  it("has a column for each, defaulting to on", () => {
    const template = SCHEMA.slice(SCHEMA.indexOf("model LetterTemplate"));
    const body = template.slice(0, template.indexOf("@@unique([organizationId, category])"));
    expect(body).toMatch(/showSignature\s+Boolean\s+@default\(true\)/);
    expect(body).toMatch(/showStamp\s+Boolean\s+@default\(true\)/);
  });

  it("honours both at the moment the image is drawn", () => {
    const code = strip(LETTERS);
    // Both were unconditional: the signature whenever a row had one, the stamp
    // whenever the organisation had one, with nothing able to say "not here".
    expect(code).toMatch(/framework\.showSignature\s*\n?\s*\? await storedImageDataUri/);
    expect(code).toMatch(/framework\.showStamp\s*\n?\s*\? await storedImageDataUri/);
  });
});

describe("a draft can be looked at without being issued", () => {
  const code = strip(LETTERS);

  it("builds the preview with the same code that issues", () => {
    // A preview drawn any other way is a second opinion about what the letter
    // looks like, and the two drift until somebody notices from a real letter.
    expect(code).toMatch(/async function composeLetterPdf\(/);
    expect(code).toMatch(/composeLetterPdf\(ctx, letter, \{ draft: true \}\)/);
    expect(code).toMatch(/const \{ pdf, rendered, today \} = await composeLetterPdf\(ctx, letter\)/);
  });

  it("still refuses to issue with unresolved placeholders", () => {
    // The gate moved, it did not go. Looking is allowed with problems; issuing
    // is not, and a letter reading "[Monthly salary]" must never go out.
    const issue = code.slice(code.indexOf("export async function issueLetter("));
    expect(issue).toMatch(/if \(!canIssue\(rendered\)\)/);
  });

  it("marks the preview so it cannot be mistaken for the real thing", () => {
    expect(code).toMatch(/watermark: options\.draft \? "DRAFT" : null/);
  });

  it("stores nothing and audits nothing on the preview path", () => {
    const preview = code.slice(
      code.indexOf("export async function previewLetterPdf("),
      code.indexOf("export async function issueLetter("),
    );
    expect(preview).not.toMatch(/storage\(\)\.put/);
    expect(preview).not.toMatch(/writeAudit/);
    expect(preview).not.toMatch(/status: "ISSUED"/);
  });
});

describe("the whole address, everywhere it appears", () => {
  it("includes the country in the address placeholder", () => {
    // The letterhead printed it and `{{organization.address}}` did not, so one
    // letter could carry two versions of the same address.
    const address = LETTERS.slice(LETTERS.indexOf("const address = ["));
    expect(address.slice(0, 400)).toMatch(/organization\?\.country/);
  });
});
