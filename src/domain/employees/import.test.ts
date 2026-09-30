import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../csv";
import {
  columnFor,
  EMPLOYEE_IMPORT_COLUMNS,
  importColumnGuide,
  importTemplateRows,
  lookupKey,
  planEmployeeImport,
  type ImportLookups,
} from "./import";

const lookups = (over: Partial<ImportLookups> = {}): ImportLookups => ({
  departments: new Map([["engineering", "dep_eng"]]),
  designations: new Map([["software engineer", "des_swe"]]),
  workLocations: new Map([["head office", "loc_ho"]]),
  shifts: new Map([["general shift", "shift_gen"]]),
  weeklyOffPatterns: new Map([["sunday off", "woff_sun"]]),
  existingCodes: new Set<string>(),
  ...over,
});

function plan(csv: string, over: Partial<ImportLookups> = {}, seatsRemaining: number | null = null) {
  const parsed = parseCsv(csv);
  if (!parsed.ok) throw new Error(parsed.message);
  return planEmployeeImport(parsed.table, lookups(over), { seatsRemaining });
}

const HEAD = "Employee Code,First Name,Last Name,Joining Date,Department";

describe("planEmployeeImport", () => {
  it("accepts a clean file", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering`);
    expect(result.errorCount).toBe(0);
    expect(result.readyCount).toBe(1);
    expect(result.rows[0]?.employee).toMatchObject({
      employeeCode: "E001",
      firstName: "Asha",
      lastName: "Rao",
      joiningDate: "2026-04-01",
      departmentId: "dep_eng",
    });
  });

  it("matches reference names regardless of case and spacing", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,  ENGINEERING  `);
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[0]?.employee?.departmentId).toBe("dep_eng");
  });

  it("refuses the whole file when a required column is absent", () => {
    const result = plan("First Name,Joining Date\nAsha,2026-04-01");
    expect(result.blocked).toContain("Employee Code");
    expect(result.rows).toHaveLength(0);
  });

  it("reports unused columns without failing", () => {
    const result = plan(`${HEAD},Favourite Colour\nE001,Asha,Rao,2026-04-01,Engineering,blue`);
    expect(result.unknownColumns).toEqual(["favouritecolour"]);
    expect(result.errorCount).toBe(0);
  });

  // Each of these is a row-level error, so the rest of the file still imports.
  it("catches a date that is not a real day", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-02-30,Engineering`);
    expect(result.rows[0]?.errors[0]).toContain("not a real YYYY-MM-DD date");
  });

  it("catches a malformed date", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,01/04/2026,Engineering`);
    expect(result.rows[0]?.errors[0]).toContain("01/04/2026");
  });

  it("catches a blank required cell", () => {
    const result = plan(`${HEAD}\n,Asha,Rao,2026-04-01,Engineering`);
    expect(result.rows[0]?.errors).toContain("Employee Code is blank.");
  });

  it("catches a department that does not exist", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Marketing`);
    expect(result.rows[0]?.errors[0]).toContain('Department "Marketing" does not exist yet');
  });

  it("catches a code repeated inside the file, naming the earlier line", () => {
    const result = plan(
      `${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering\nE001,Vikram,Singh,2026-04-02,Engineering`,
    );
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[1]?.errors[0]).toContain("already used on line 2");
  });

  it("catches a code that already belongs to somebody", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering`, {
      existingCodes: new Set(["e001"]),
    });
    expect(result.rows[0]?.errors[0]).toContain("already belongs to somebody here");
  });

  it("catches an invalid email", () => {
    const result = plan(
      "Employee Code,First Name,Joining Date,Work Email\nE001,Asha,2026-04-01,asha.example.com",
    );
    expect(result.rows[0]?.errors[0]).toContain("not an email address");
  });

  it("normalises an enum written with a space", () => {
    const result = plan(
      "Employee Code,First Name,Joining Date,Employment Type\nE001,Asha,2026-04-01,full time",
    );
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[0]?.employee?.employmentType).toBe("FULL_TIME");
  });

  it("catches an enum outside the allowed set", () => {
    const result = plan(
      "Employee Code,First Name,Joining Date,Work Mode\nE001,Asha,2026-04-01,Hybrid-ish",
    );
    expect(result.rows[0]?.errors[0]).toContain("Work Mode");
  });

  it("counts good and bad rows separately", () => {
    const result = plan(
      `${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering\nE002,,Singh,2026-04-02,Engineering`,
    );
    expect(result.readyCount).toBe(1);
    expect(result.errorCount).toBe(1);
  });

  it("reports the spreadsheet line number a person will look for", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering`);
    expect(result.rows[0]?.line).toBe(2);
  });

  // Seats are the one check that has to consider the file as a whole.
  it("blocks a file that would exceed the free seats, with the numbers", () => {
    const result = plan(
      `${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering\nE002,Vikram,Singh,2026-04-02,Engineering`,
      {},
      1,
    );
    expect(result.blocked).toContain("would add 2 people but only 1 seat");
  });

  it("blocks outright when there are no seats at all", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering`, {}, 0);
    expect(result.blocked).toContain("no seats left");
  });

  it("allows a file that exactly fills the free seats", () => {
    const result = plan(`${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering`, {}, 1);
    expect(result.blocked).toBeUndefined();
  });

  // Rows with errors do not consume seats, because they will not be created.
  it("counts only importable rows against the seats", () => {
    const result = plan(
      `${HEAD}\nE001,Asha,Rao,2026-04-01,Engineering\nE002,,Singh,2026-04-02,Engineering`,
      {},
      1,
    );
    expect(result.blocked).toBeUndefined();
  });

  it("says so when the file has only a header", () => {
    const result = plan(HEAD);
    expect(result.blocked).toContain("nothing else");
  });
});

describe("importTemplateRows", () => {
  // The property that matters is not that the headers equal the keys — friendly
  // labels are allowed to differ — but that every one of them resolves to a
  // column. This test caught two that did not: "Address" and "Emergency
  // Contact" would have been silently dropped from the importer's own template.
  it("writes headers the importer recognises", () => {
    const parsed = parseCsv(toCsv(importTemplateRows()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const unresolved = parsed.table.headers.filter((h) => columnFor(h) === null);
    expect(unresolved).toEqual([]);
    expect(parsed.table.headers).toHaveLength(EMPLOYEE_IMPORT_COLUMNS.length);
  });

  // The template must be importable as-is, or the first thing a person tries
  // after downloading it fails.
  it("produces an example row that validates", () => {
    const result = plan(
      toCsv(importTemplateRows()),
      { departments: new Map(), designations: new Map() },
    );
    expect(result.rows[0]?.errors).toEqual([]);
  });
});

describe("header aliases", () => {
  it("accepts the names people actually type", () => {
    const result = plan(`Emp Code,First Name,Date of Joining,Mobile
E001,Asha,2026-04-01,98765`);
    expect(result.blocked).toBeUndefined();
    expect(result.unknownColumns).toEqual([]);
    expect(result.rows[0]?.employee).toMatchObject({
      employeeCode: "E001",
      joiningDate: "2026-04-01",
      phone: "98765",
    });
  });

  it("still reports a column it genuinely does not know", () => {
    const result = plan(`Employee Code,First Name,Joining Date,Shoe Size
E001,Asha,2026-04-01,9`);
    expect(result.unknownColumns).toEqual(["shoesize"]);
  });
});

describe("lookupKey", () => {
  it("collapses case and internal spacing", () => {
    expect(lookupKey("  Head   Office ")).toBe("head office");
  });
});

/**
 * The columns added in round 5, and the two-pass resolution they needed.
 *
 * The manager column is the one worth reading: it is checked here and resolved
 * by the service, because neither party has an id until the rows are written
 * and a spreadsheet sorted by name puts managers in no particular place.
 */
describe("the columns a payroll actually needs", () => {
  const HEAD2 =
    "Employee Code,First Name,Joining Date,Annual CTC,Reports To,Permanent From,Login Role,Marks Own Attendance";

  it("reads an annual CTC in rupees as paise", () => {
    const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,660000,,,,`);
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[0]?.annualCtcPaise).toBe(66_000_000);
  });

  it("accepts the ways people actually type an amount", () => {
    // Quoted, because a comma inside a cell is what quoting is for -- which is
    // also how a spreadsheet writes it.
    for (const written of ['"6,60,000"', "660000.00", "Rs 660000", "\u20B9660000", " 660000 "]) {
      const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,${written},,,,`);
      expect(result.rows[0]?.errors, written).toEqual([]);
      expect(result.rows[0]?.annualCtcPaise, written).toBe(66_000_000);
    }
  });

  it("does not turn a rounding error into somebody's salary", () => {
    // 6600.07 * 100 is 660006.9999999999 in floating point, and a fractional
    // paise poisons every component derived from it.
    const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,6600.07,,,,`);
    expect(result.rows[0]?.annualCtcPaise).toBe(660_007);
    expect(Number.isSafeInteger(result.rows[0]?.annualCtcPaise)).toBe(true);
  });

  it("refuses a CTC that is not an amount, and one that is zero", () => {
    expect(plan(`${HEAD2}\nE001,Asha,2026-04-01,twelve lakh,,,,`).rows[0]?.errors[0]).toContain(
      "Annual CTC",
    );
    expect(plan(`${HEAD2}\nE001,Asha,2026-04-01,0,,,,`).rows[0]?.errors[0]).toContain("zero");
  });

  it("lets a manager appear below the person reporting to them", () => {
    const result = plan(
      `${HEAD2}\nE002,Asha,2026-04-01,,E001,,,\nE001,Vikram,2024-01-15,,,,,`,
    );
    expect(result.errorCount).toBe(0);
    expect(result.rows[0]?.reportsToCode).toBe("E001");
    expect(result.rows[1]?.reportsToCode).toBeUndefined();
  });

  it("accepts a manager who is already in the directory", () => {
    const result = plan(`${HEAD2}\nE002,Asha,2026-04-01,,M001,,,`, {
      existingCodes: new Set(["m001"]),
    });
    expect(result.rows[0]?.errors).toEqual([]);
    expect(result.rows[0]?.reportsToCode).toBe("M001");
  });

  it("refuses a manager who is in neither the file nor the directory", () => {
    const result = plan(`${HEAD2}\nE002,Asha,2026-04-01,,GHOST,,,`);
    expect(result.rows[0]?.errors[0]).toContain("GHOST");
    expect(result.rows[0]?.employee).toBeUndefined();
  });

  it("refuses somebody who reports to themselves", () => {
    const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,,E001,,,`);
    expect(result.rows[0]?.errors[0]).toContain("own Employee Code");
  });

  it("keeps Marks Own Attendance a tri-state", () => {
    const yes = plan(`${HEAD2}\nE001,Asha,2026-04-01,,,,,YES`);
    const no = plan(`${HEAD2}\nE001,Asha,2026-04-01,,,,,NO`);
    const blank = plan(`${HEAD2}\nE001,Asha,2026-04-01,,,,,`);
    expect(yes.rows[0]?.employee?.allowSelfMarking).toBe(true);
    expect(no.rows[0]?.employee?.allowSelfMarking).toBe(false);
    // Not false. Null means "follow the organisation", and the difference is
    // whether switching the organisation's rule later reaches this person.
    expect(blank.rows[0]?.employee?.allowSelfMarking).toBeNull();
  });

  it("refuses a Permanent From that is before the joining date", () => {
    const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,,,2026-03-01,,`);
    expect(result.rows[0]?.errors[0]).toContain("before the Joining Date");
  });

  it("carries a valid Permanent From onto the employee", () => {
    const result = plan(`${HEAD2}\nE001,Asha,2026-04-01,,,2026-10-01,,`);
    expect(result.rows[0]?.employee?.confirmationDate).toBe("2026-10-01");
  });

  it("only accepts login roles the product has", () => {
    expect(plan(`${HEAD2}\nE001,Asha,2026-04-01,,,,SUPERVISOR,`).rows[0]?.loginRole).toBe(
      "SUPERVISOR",
    );
    expect(plan(`${HEAD2}\nE001,Asha,2026-04-01,,,,SUPERADMIN,`).rows[0]?.errors[0]).toContain(
      "Login Role",
    );
  });
});

describe("two headers meaning one column", () => {
  it("refuses a file carrying both Email and Work Email", () => {
    const result = plan(
      "Employee Code,First Name,Joining Date,Email,Work Email\n" +
        "E001,Asha,2026-04-01,asha@home.example,asha@work.example",
    );
    // Both alias to workemail. The parser's duplicate check cannot see it,
    // because the two normalise to different strings.
    expect(result.blocked).toContain("both read as");
    expect(result.blocked).toContain("Work Email");
    expect(result.rows).toHaveLength(0);
  });

  it("still accepts a file that uses only one of them", () => {
    const result = plan(
      "Employee Code,First Name,Joining Date,Email\nE001,Asha,2026-04-01,asha@work.example",
    );
    expect(result.blocked).toBeUndefined();
    expect(result.rows[0]?.employee?.workEmail).toBe("asha@work.example");
  });
});

describe("the template", () => {
  it("fills every column on every example row", () => {
    const rows = importTemplateRows({
      department: "Engineering",
      designation: "Software Engineer",
      workLocation: "Head Office",
      shift: "General Shift",
      weeklyOffPattern: "Sunday Off",
    });
    const [header, ...examples] = rows as [string[], ...string[][]];
    expect(header).toHaveLength(EMPLOYEE_IMPORT_COLUMNS.length);
    expect(examples).toHaveLength(2);
    for (const row of examples) {
      expect(row).toHaveLength(EMPLOYEE_IMPORT_COLUMNS.length);
    }
    // Every cell filled, except the two that are deliberately blank: the top
    // person reports to nobody, and follows the organisation's attendance rule.
    const blanks = examples.flatMap((row) =>
      row.map((cell, i) => (cell === "" ? header[i] : null)).filter(Boolean),
    );
    expect(blanks.sort()).toEqual(["Marks Own Attendance", "Reports To"]);
  });

  it("names the organisation's own references, and leaves them blank when it has none", () => {
    const header = importTemplateRows()[0] as string[];
    const withNames = importTemplateRows({ department: "Operations" })[1] as string[];
    const without = importTemplateRows()[1] as string[];
    const column = header.indexOf("Department");
    expect(withNames[column]).toBe("Operations");
    // A brand-new organisation has no departments, and naming one would fail
    // every row that used it.
    expect(without[column]).toBe("");
  });

  it("downloads as a file this importer reads back with both rows ready", () => {
    const csv = toCsv(
      importTemplateRows({
        department: "Engineering",
        designation: "Software Engineer",
        workLocation: "Head Office",
        shift: "General Shift",
        weeklyOffPattern: "Sunday Off",
      }),
    );
    const result = plan(csv);
    expect(result.blocked).toBeUndefined();
    expect(result.errorCount).toBe(0);
    expect(result.readyCount).toBe(2);
    expect(result.unknownColumns).toEqual([]);
    // The out-of-order manager, which is the reason there are two rows.
    expect(result.rows[0]?.reportsToCode).toBe("EXAMPLE-001");
    expect(result.rows[0]?.annualCtcPaise).toBe(66_000_000);
  });
});

describe("importColumnGuide", () => {
  it("describes every column the parser matches, and nothing else", () => {
    const guide = importColumnGuide();
    expect(guide.map((c) => c.key)).toEqual(EMPLOYEE_IMPORT_COLUMNS.map((c) => c.key));
    expect(guide.filter((c) => c.required).map((c) => c.label)).toEqual([
      "Employee Code",
      "First Name",
      "Joining Date",
    ]);
  });

  it("offers the values the parser will accept, not a second copy of them", () => {
    const gender = importColumnGuide().find((c) => c.key === "gender");
    expect(gender?.values).toEqual(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]);
    // Proved by the parser rather than by repeating the list: every value the
    // guide offers has to be one a row can carry.
    for (const value of gender?.values ?? []) {
      const result = plan(
        `Employee Code,First Name,Joining Date,Gender\nE001,Asha,2026-04-01,${value}`,
      );
      expect(result.rows[0]?.errors, value).toEqual([]);
    }
  });
});
