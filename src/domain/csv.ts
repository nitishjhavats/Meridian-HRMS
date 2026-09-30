/**
 * Reading CSV.
 *
 * The product already writes CSV (`csvResponse`); this is the other half, for
 * loading a spreadsheet of employees. It is deliberately a small hand-written
 * parser rather than a dependency: the most common npm package for reading
 * spreadsheets has a poor advisory history, and this application holds payroll,
 * PAN and Aadhaar. CSV is two clicks away in both Excel and Google Sheets, so
 * the cost of the constraint falls on nobody.
 *
 * Small does not mean naive. Every one of these appears in real exports:
 *
 *   - a UTF-8 byte-order mark, which Excel writes and which otherwise turns the
 *     first header into `﻿employeeCode` and makes the column go missing;
 *   - CRLF line endings, and a trailing newline at the end of the file;
 *   - quoted fields containing commas, quotes doubled as `""`, and newlines,
 *     which is how any address column arrives;
 *   - ragged rows, where a trailing empty column has simply been dropped.
 *
 * Pure and synchronous, so the whole thing is unit-testable and the preview a
 * person sees is produced by exactly the code that will do the import.
 */

export interface CsvTable {
  /** Header names, trimmed, in file order. */
  headers: string[];
  /** One entry per data row: the header name mapped to its cell. */
  rows: CsvRow[];
}

export interface CsvRow {
  /** 1-based line number as a person counts them in a spreadsheet. */
  line: number;
  cells: Record<string, string>;
}

/**
 * The character between fields.
 *
 * A comma, except when the file plainly is not using one. Excel on a machine
 * whose locale uses the comma as a decimal separator writes semicolons instead,
 * and it does so silently: "Save as CSV" produces `a;b;c` with no warning and no
 * way to change it short of changing the operating system's regional settings.
 * Such a file parsed as commas is one enormous column, which used to surface as
 * "the file is missing Employee Code, First Name, Joining Date" — true, and
 * useless.
 *
 * Decided from the header line only, and only by counting: whichever of the two
 * appears more often outside quotes is the separator. A header line is short and
 * made of field names, so a tie or a zero count means a single-column file,
 * where the answer does not matter.
 */
export function detectDelimiter(input: string): "," | ";" {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      // A doubled quote is an escaped one and leaves the state alone.
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "\n" || char === "\r") break;
    if (char === ",") commas++;
    else if (char === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

/** Splits CSV text into raw fields. Handles quotes, embedded newlines and CRLF. */
export function parseCsvRows(input: string, delimiter: "," | ";" = ","): string[][] {
  // Excel's byte-order mark would otherwise become part of the first header.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let seenAnything = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      seenAnything = true;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = "";
      seenAnything = true;
      continue;
    }

    if (char === "\r") {
      // Swallow CRLF as one break; a lone CR is treated the same way.
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      seenAnything = false;
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      seenAnything = false;
      continue;
    }

    field += char;
    seenAnything = true;
  }

  // A trailing newline should not produce a phantom final row.
  if (seenAnything || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export type CsvParseResult =
  | { ok: true; table: CsvTable }
  | { ok: false; message: string };

/**
 * Parses CSV into named rows.
 *
 * Headers are matched case-insensitively and ignore spaces and underscores, so
 * `Employee Code`, `employee_code` and `employeecode` are the same column —
 * people retype these by hand and there is nothing to be gained by being strict
 * about it. Entirely blank lines are dropped, because a spreadsheet exported
 * from a range almost always has some.
 */
export function parseCsv(input: string): CsvParseResult {
  const raw = parseCsvRows(input, detectDelimiter(input)).filter((cells) =>
    cells.some((c) => c.trim() !== ""),
  );

  if (raw.length === 0) {
    return { ok: false, message: "That file is empty." };
  }

  const headerCells = raw[0] as string[];
  const headers = headerCells.map((h) => normaliseHeader(h));

  if (headers.every((h) => h === "")) {
    return { ok: false, message: "The first row must name the columns." };
  }

  const duplicate = headers.find((h, i) => h !== "" && headers.indexOf(h) !== i);
  if (duplicate) {
    return {
      ok: false,
      message: `The column "${duplicate}" appears more than once. Every column needs its own name.`,
    };
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const cells: Record<string, string> = {};
    const values = raw[i] as string[];
    headers.forEach((header, column) => {
      if (header === "") return;
      // Ragged rows are normal: a trailing empty column is often dropped.
      cells[header] = (values[column] ?? "").trim();
    });
    rows.push({ line: i + 1, cells });
  }

  return { ok: true, table: { headers, rows } };
}

/** `Employee Code` and `employee_code` both become `employeecode`. */
export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Serialises a table back to CSV — used for the downloadable template, so the
 * file a person receives is quoted exactly the way this parser expects to read
 * it back.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell,
        )
        .join(","),
    )
    .join("\r\n");
}
