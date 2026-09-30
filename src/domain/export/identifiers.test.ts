import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IDENTIFIER_NOTICE,
  REVEALED_IDENTIFIERS,
  modelsWithRevealedIdentifiers,
  revealedAs,
} from "./identifiers";

/**
 * The list of encrypted columns an export reads back.
 *
 * It is short and it is the only hole in a rule that is otherwise a pattern:
 * everything matching `/(cipher|hash|secret|token|password|descriptor)/i` is
 * redacted, which is what keeps a column added next month safe on the day it
 * appears. So the tests worth having are the ones that fail when the hole gets
 * bigger by accident.
 */

const EXPORT_SOURCE = readFileSync(path.resolve("src/services/export/index.ts"), "utf8");

/** Comments stripped, so a comment about a column cannot read as the column. */
const EXPORT_CODE = EXPORT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^[ 	]*\/\/.*$/gm,
  "",
);

describe("what an export reads back", () => {
  it("reveals exactly the six employee fields a payroll migration needs", () => {
    expect(REVEALED_IDENTIFIERS).toEqual({
      employee: {
        panCipher: "pan",
        uanCipher: "uan",
        bankNameCipher: "bankName",
        bankAccountCipher: "bankAccount",
        bankIfscCipher: "bankIfsc",
        aadhaarCipher: "aadhaarLastFour",
      },
    });
  });

  it("names Aadhaar for what it actually is", () => {
    // Only the last four digits are stored -- the rest is discarded at write
    // time -- so calling the field `aadhaar` would promise a number this
    // product does not have.
    expect(revealedAs("employee", "aadhaarCipher")).toBe("aadhaarLastFour");
  });

  it("leaves every credential redacted", () => {
    for (const column of [
      "passwordHash",
      "totpSecretCipher",
      "passwordCipher",
      "sessionTokenHash",
      "faceDescriptor",
      "refreshTokenHash",
    ]) {
      expect(revealedAs("employee", column), column).toBeNull();
    }
  });

  it("leaves health data redacted", () => {
    // Blood group sits in the same encrypted block as the bank details and is
    // deliberately not on the list: not needed to run payroll, and it carries
    // obligations the rest of the list does not.
    expect(revealedAs("employee", "bloodGroupCipher")).toBeNull();
  });

  it("is scoped to the model, so the same column name elsewhere stays redacted", () => {
    expect(revealedAs("user", "panCipher")).toBeNull();
    expect(revealedAs("organization", "bankAccountCipher")).toBeNull();
    expect(modelsWithRevealedIdentifiers()).toEqual(["employee"]);
  });

  it("says so in the archive, in words a person opening it will read", () => {
    const notice = IDENTIFIER_NOTICE.join(" ");
    for (const field of ["PAN", "UAN", "bank account", "IFSC"]) {
      expect(notice, field).toContain(field);
    }
    expect(notice).toContain("last four digits");
  });
});

/**
 * A pure list pins nothing on its own if its caller stops consulting it — the
 * lesson from every previous round. These read the export service's source.
 */
describe("the export service still redacts by pattern", () => {
  it("keeps the pattern rule as the default", () => {
    expect(EXPORT_SOURCE).toMatch(
      /const SECRET_COLUMN = \/\(cipher\|hash\|secret\|token\|password\|descriptor\)\/i/,
    );
    expect(EXPORT_SOURCE).toMatch(/if \(SECRET_COLUMN\.test\(keyName\)\) return "\[redacted\]"/);
  });

  it("asks this module which columns to read back, rather than deciding itself", () => {
    expect(EXPORT_SOURCE).toMatch(/const name = revealedAs\(model, column\)/);
    expect(EXPORT_SOURCE).toMatch(/if \(!name \|\| typeof value !== "string"/);
    // A second list of column names living in the export service is exactly the
    // drift this module exists to prevent.
    expect(EXPORT_CODE).not.toMatch(/panCipher|bankAccountCipher|uanCipher/);
  });

  it("adds the readable fields beside the redacted ones rather than replacing them", () => {
    // `{ ...cleaned, ...revealed }`. Replacing `panCipher` in place would give a
    // row whose shape no longer matches the schema it came from, and would hide
    // which fields were decrypted on the way out.
    expect(EXPORT_SOURCE).toMatch(/return \{ \.\.\.cleaned, \.\.\.revealed \}/);
  });

  it("writes a separate audit entry naming the fields and the number of people", () => {
    expect(EXPORT_SOURCE).toMatch(/action: "export\.identifiers\.included"/);
    expect(EXPORT_SOURCE).toMatch(/people: identifiersRevealed/);
    // The fields, never a value. An audit log that quoted a bank account would
    // be a second copy of the thing it is recording the release of.
    const entry = EXPORT_SOURCE.slice(
      EXPORT_SOURCE.indexOf('action: "export.identifiers.included"'),
    ).slice(0, 400);
    expect(entry).not.toMatch(/decrypt/);
  });

  it("only counts a row once, however many identifiers it carried", () => {
    expect(EXPORT_SOURCE).toMatch(
      /if \(Object\.keys\(revealed\)\.length > 0\) identifiersRevealed\+\+/,
    );
  });
});
