import { describe, expect, it } from "vitest";
import {
  ALL_IDENTIFIERS,
  DOCUMENT_KINDS,
  IDENTIFIERS,
  NO_IDENTIFIERS,
  identifiersFor,
  resolveDocumentIdentifiers,
} from "./documentIdentifiers";

const VALUES = {
  cin: "U72900PN2019PTC123456",
  gstin: "27AABCU9603R1ZM",
  panNumber: "AABCU9603R",
  tan: "PNEU12345A",
  pfCode: "PN/PUN/1234567",
  esiCode: "31000123450001",
};

describe("resolveDocumentIdentifiers", () => {
  it("honours a stored choice", () => {
    const stored = { payslip: ["pan", "pf"], letter: ["cin"], fnf: [] };
    expect(resolveDocumentIdentifiers(stored, false)).toEqual(stored);
  });

  it("falls back to all six when the old switch was on", () => {
    // Nothing may change under an organisation the moment this ships: the
    // boolean meant every identifier on every document, and that is what they
    // keep until they open the new screen.
    expect(resolveDocumentIdentifiers(null, true)).toEqual(ALL_IDENTIFIERS);
    expect(resolveDocumentIdentifiers(undefined, true)).toEqual(ALL_IDENTIFIERS);
  });

  it("falls back to none when it was off", () => {
    expect(resolveDocumentIdentifiers(null, false)).toEqual(NO_IDENTIFIERS);
  });

  it("falls back rather than throwing on a payload it cannot read", () => {
    // This sits on the path that renders a payslip. Refusing to draw somebody's
    // payslip because a settings blob is malformed is the wrong trade.
    for (const rubbish of ["", 7, [], { payslip: "pan" }, { payslip: ["nonsense"] }]) {
      expect(resolveDocumentIdentifiers(rubbish, false)).toEqual(NO_IDENTIFIERS);
      expect(resolveDocumentIdentifiers(rubbish, true)).toEqual(ALL_IDENTIFIERS);
    }
  });

  it("fills in a document the stored value forgot", () => {
    const partial = { payslip: ["pan"] };
    expect(resolveDocumentIdentifiers(partial, false)).toEqual({
      payslip: ["pan"],
      letter: [],
      fnf: [],
    });
  });
});

describe("identifiersFor", () => {
  it("returns only what that document asked for", () => {
    const chosen = { payslip: ["pan" as const, "pf" as const], letter: ["cin" as const], fnf: [] };
    expect(identifiersFor("payslip", chosen, VALUES).map((i) => i.label)).toEqual(["PAN", "PF"]);
    expect(identifiersFor("letter", chosen, VALUES).map((i) => i.label)).toEqual(["CIN"]);
    expect(identifiersFor("fnf", chosen, VALUES)).toEqual([]);
  });

  it("never prints a label with nothing after it", () => {
    // The reason a company with a CIN and no GSTIN could not use the old
    // switch: it printed "GSTIN" followed by nothing.
    const result = identifiersFor("letter", ALL_IDENTIFIERS, { cin: VALUES.cin, gstin: "  " });
    expect(result).toEqual([{ label: "CIN", value: VALUES.cin }]);
  });

  it("keeps a fixed order, whatever order they were ticked in", () => {
    // Two documents from one organisation must not disagree about the order.
    const backwards = { payslip: ["esi" as const, "cin" as const], letter: [], fnf: [] };
    expect(identifiersFor("payslip", backwards, VALUES).map((i) => i.label)).toEqual(["CIN", "ESI"]);
  });

  it("maps every identifier to a column that resolves", () => {
    // A key whose column name is wrong would silently print nothing, and the
    // organisation would think the value was missing rather than the wiring.
    const all = identifiersFor("letter", ALL_IDENTIFIERS, VALUES);
    expect(all).toHaveLength(IDENTIFIERS.length);
    for (const { value } of all) expect(value).toBeTruthy();
  });

  it("covers every document kind", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(() => identifiersFor(kind, ALL_IDENTIFIERS, VALUES)).not.toThrow();
    }
  });
});
