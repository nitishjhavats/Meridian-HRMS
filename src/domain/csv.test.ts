import { describe, expect, it } from "vitest";
import { detectDelimiter, normaliseHeader, parseCsv, parseCsvRows, toCsv } from "./csv";

describe("parseCsvRows", () => {
  it("splits a plain file", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  // Excel writes a byte-order mark. Without stripping it the first header
  // silently stops matching and the column looks missing.
  it("strips a UTF-8 byte-order mark", () => {
    const [header] = parseCsvRows("﻿code,name\nE1,Asha");
    expect(header?.[0]).toBe("code");
  });

  it("treats CRLF as one line break", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not invent a row for a trailing newline", () => {
    expect(parseCsvRows("a\n1\n")).toHaveLength(2);
  });

  it("keeps commas inside quotes", () => {
    expect(parseCsvRows('a,b\n"Flat 4, Tech Park",Patna')).toEqual([
      ["a", "b"],
      ["Flat 4, Tech Park", "Patna"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsvRows('a\n"She said ""hello"""')).toEqual([["a"], ['She said "hello"']]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseCsvRows('a,b\n"line one\nline two",x')).toEqual([
      ["a", "b"],
      ["line one\nline two", "x"],
    ]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseCsvRows("a,b,c\n1,,")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });
});

describe("parseCsv", () => {
  it("maps rows onto normalised headers", () => {
    const result = parseCsv("Employee Code,First Name\nE001,Asha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(["employeecode", "firstname"]);
    expect(result.table.rows[0]?.cells).toEqual({ employeecode: "E001", firstname: "Asha" });
  });

  // The line number is what a person will look for in their spreadsheet, so it
  // counts the header row and starts at 1.
  it("reports the spreadsheet line number", () => {
    const result = parseCsv("code\nE1\nE2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it("drops entirely blank lines", () => {
    const result = parseCsv("code\nE1\n\n,\nE2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(2);
  });

  it("tolerates a row missing its trailing columns", () => {
    const result = parseCsv("a,b,c\n1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]?.cells).toEqual({ a: "1", b: "", c: "" });
  });

  it("refuses an empty file", () => {
    expect(parseCsv("")).toEqual({ ok: false, message: "That file is empty." });
  });

  it("refuses duplicate columns", () => {
    const result = parseCsv("code,Code\n1,2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("more than once");
  });
});

describe("normaliseHeader", () => {
  it("ignores case, spaces, underscores and hyphens", () => {
    for (const variant of ["Employee Code", "employee_code", "EMPLOYEE-CODE", " employeeCode "]) {
      expect(normaliseHeader(variant)).toBe("employeecode");
    }
  });
});

describe("toCsv", () => {
  it("round-trips through the parser", () => {
    const rows = [
      ["code", "address"],
      ["E1", 'Flat 4, "The Park"\nPatna'],
    ];
    const parsed = parseCsvRows(toCsv(rows));
    expect(parsed).toEqual(rows);
  });

  it("leaves ordinary values unquoted", () => {
    expect(toCsv([["a", "b"]])).toBe("a,b");
  });
});

/**
 * Excel writes semicolons on a machine whose locale uses the comma as a decimal
 * separator, and says nothing about it. Such a file read as commas is one
 * enormous column, which used to surface as "the file is missing Employee Code,
 * First Name, Joining Date" -- true, and useless.
 */
describe("the separator", () => {
  it("reads an ordinary comma file", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("reads a semicolon file as a semicolon file", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("decides on the header line alone", () => {
    // A comma-separated file whose *data* is full of semicolons stays commas.
    expect(detectDelimiter("Name,Note\nAsha,\"a; b; c; d; e\"")).toBe(",");
  });

  it("ignores separators inside a quoted header", () => {
    expect(detectDelimiter('"Surname, first";Code;Joining Date')).toBe(";");
  });

  it("falls back to a comma when there is nothing to go on", () => {
    expect(detectDelimiter("OneColumn")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });

  it("parses a semicolon file into the same table a comma file gives", () => {
    const commas = parseCsv("Employee Code,First Name\nE001,Asha");
    const semicolons = parseCsv("Employee Code;First Name\nE001;Asha");
    expect(semicolons.ok).toBe(true);
    if (!commas.ok || !semicolons.ok) return;
    expect(semicolons.table).toEqual(commas.table);
  });

  it("still honours quoting with a semicolon separator", () => {
    const result = parseCsv('Name;Address\nAsha;"12 Bailey Road; Patna"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]?.cells.address).toBe("12 Bailey Road; Patna");
  });

  it("reads a semicolon file that also carries a byte-order mark", () => {
    const result = parseCsv("\uFEFFEmployee Code;First Name\nE001;Asha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.headers).toEqual(["employeecode", "firstname"]);
  });
});
