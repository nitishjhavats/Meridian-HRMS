import type { CsvRow, CsvTable } from "../csv";
import { EMPLOYEE_LOGIN_ROLES } from "./loginRoles";
import { normaliseHeader } from "../csv";

/**
 * Turning a spreadsheet into employees.
 *
 * Pure: it takes the parsed table and what the organisation already has, and
 * returns a verdict per row. Nothing here writes. That separation is the whole
 * design — the screen shows a person exactly this result before anything is
 * committed, because a bulk import that half-succeeds into a payroll system is
 * worse than one that refuses outright.
 *
 * References are matched **by name**, because a spreadsheet says "Engineering",
 * not a cuid. Names are compared case-insensitively and with spacing collapsed;
 * an unmatched one is an error on that row rather than a silent null, since an
 * employee quietly landing in no department is the kind of thing nobody notices
 * until payroll runs.
 *
 * Salary *is* importable, and used not to be. The old reasoning was that a
 * salary profile is a structure of components that has to add up, so a bare CTC
 * column would mean inventing a structure on somebody's behalf. That was true
 * and it had the wrong conclusion: the single-create form asks for exactly one
 * number, annual CTC, and lets the organisation's own distribution derive the
 * structure from it. A bulk import that refused the same number produced a
 * hundred employees payroll could not pay, which is a worse invention than the
 * one it was avoiding.
 *
 * The manager column is resolved by **employee code**, and deliberately not
 * here: a manager may appear further down the file than the person reporting to
 * them, and neither has an id until the rows are written. This module checks
 * only that the code will resolve -- against the file itself or against the
 * organisation -- and the service links them once every row exists.
 */

export interface ImportColumn {
  /** Canonical normalised header. */
  key: string;
  /** What the template writes, and what error messages call it. */
  label: string;
  /**
   * Other normalised headers that mean the same column.
   *
   * Two reasons. Friendly labels do not always normalise back to their own key —
   * "Address" would not match `addressline1`, so the template's own column would
   * have been silently ignored. And real files are typed by people: "Emp Code",
   * "Mobile", "Date of Joining" all turn up.
   */
  aliases?: string[];
  required?: boolean;
  hint?: string;
}

export const EMPLOYEE_IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "employeecode", label: "Employee Code", aliases: ["empcode", "code", "employeeid", "empid"], required: true, hint: "Unique within your organisation" },
  { key: "firstname", label: "First Name", aliases: ["givenname", "firstnames"], required: true },
  { key: "lastname", label: "Last Name", aliases: ["surname", "familyname"] },
  { key: "joiningdate", label: "Joining Date", aliases: ["dateofjoining", "doj", "joindate"], required: true, hint: "YYYY-MM-DD" },
  { key: "workemail", label: "Work Email", aliases: ["email", "officialemail"] },
  { key: "personalemail", label: "Personal Email" },
  { key: "phone", label: "Phone", aliases: ["mobile", "contact", "phonenumber"] },
  { key: "gender", label: "Gender", hint: "MALE, FEMALE, OTHER or UNDISCLOSED" },
  { key: "dateofbirth", label: "Date Of Birth", aliases: ["dob", "birthdate"], hint: "YYYY-MM-DD" },
  { key: "employmenttype", label: "Employment Type", hint: "FULL_TIME, PART_TIME, CONTRACT, INTERN or CONSULTANT" },
  { key: "workmode", label: "Work Mode", hint: "ONSITE, REMOTE or HYBRID" },
  { key: "employmentstate", label: "Employment State", hint: "TRAINING, PROBATION, REGULAR, CONFIRMED or NOTICE_PERIOD" },
  { key: "confirmationdate", label: "Permanent From", aliases: ["probationend", "probationenddate", "permanentfrom"], hint: "YYYY-MM-DD -- the day training or probation ends" },
  { key: "department", label: "Department", hint: "Must already exist" },
  { key: "designation", label: "Designation", hint: "Must already exist" },
  { key: "reportsto", label: "Reports To", aliases: ["manager", "managercode", "reportingmanager", "reportstocode", "reportstoemployeecode"], hint: "Another Employee Code -- from this file or already in the directory" },
  { key: "worklocation", label: "Work Location", aliases: ["location", "office", "branch"], hint: "Must already exist" },
  { key: "shift", label: "Shift", hint: "Must already exist" },
  { key: "weeklyoffpattern", label: "Weekly Off Pattern", aliases: ["weeklyoff", "offpattern"], hint: "Must already exist" },
  { key: "annualctc", label: "Annual CTC", aliases: ["ctc", "annualsalary", "ctcannual", "annualctcrupees", "salary"], hint: "Rupees a year, e.g. 660000. Blank means payroll cannot pay them yet" },
  { key: "loginrole", label: "Login Role", aliases: ["role", "accessrole"], hint: "One of the roles listed below. Only used when logins are switched on" },
  { key: "marksownattendance", label: "Marks Own Attendance", aliases: ["selfattendance", "allowselfmarking", "marksattendance"], hint: "YES or NO. Blank follows the organisation's rule" },
  { key: "addressline1", label: "Address", aliases: ["address", "addressline"] },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "postalcode", label: "Postal Code", aliases: ["pincode", "pin", "zip", "zipcode"] },
  { key: "emergencyname", label: "Emergency Contact", aliases: ["emergencycontact", "emergencycontactname"] },
  { key: "emergencyphone", label: "Emergency Phone" },
  { key: "emergencyrelation", label: "Emergency Relation" },
  { key: "bloodgroup", label: "Blood Group" },
  { key: "pan", label: "PAN", hint: "Stored encrypted" },
  { key: "aadhaar", label: "Aadhaar", hint: "Stored encrypted" },
  { key: "bankname", label: "Bank Name" },
  { key: "bankaccount", label: "Bank Account", aliases: ["accountnumber", "bankaccountnumber"], hint: "Stored encrypted" },
  { key: "bankifsc", label: "Bank IFSC", aliases: ["ifsc", "ifsccode"], hint: "Stored encrypted" },
  { key: "uan", label: "UAN", hint: "Stored encrypted" },
];

/** Name → id, for everything an employee row can point at. */
export interface ImportLookups {
  departments: ReadonlyMap<string, string>;
  designations: ReadonlyMap<string, string>;
  workLocations: ReadonlyMap<string, string>;
  shifts: ReadonlyMap<string, string>;
  weeklyOffPatterns: ReadonlyMap<string, string>;
  /** Employee codes already in use in this organisation, lowercased. */
  existingCodes: ReadonlySet<string>;
}

/** Keys the caller may pass straight to `createEmployee`. */
export interface ImportedEmployee {
  employeeCode: string;
  firstName: string;
  lastName?: string | null;
  joiningDate: string;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  employmentType?: string;
  workMode?: string;
  employmentState?: string;
  confirmationDate?: string | null;
  allowSelfMarking?: boolean | null;
  departmentId?: string | null;
  designationId?: string | null;
  workLocationId?: string | null;
  shiftId?: string | null;
  weeklyOffPatternId?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  emergencyRelation?: string | null;
  bloodGroup?: string | null;
  pan?: string | null;
  aadhaar?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  uan?: string | null;
}

export interface ImportRow {
  line: number;
  employeeCode: string;
  name: string;
  errors: string[];
  /** Present only when the row has no errors. */
  employee?: ImportedEmployee;
  /**
   * Annual cost to company in paise, when the row carried one.
   *
   * Kept beside the employee rather than inside it because it is not a column
   * on the employee: it becomes the opening `SalaryProfile`, written after the
   * row exists, exactly as the single-create form does it.
   */
  annualCtcPaise?: number;
  /**
   * The manager's employee code, verified to be resolvable and not yet
   * resolved -- see the note at the top of this file.
   */
  reportsToCode?: string;
  /** The login role this row asked for, when logins are switched on. */
  loginRole?: string;
}

export interface ImportPlan {
  rows: ImportRow[];
  readyCount: number;
  errorCount: number;
  /** Columns in the file that this importer does not use. */
  unknownColumns: string[];
  /** Required columns the file does not have at all. */
  missingColumns: string[];
  /** Set when the file as a whole cannot be imported, whatever the rows say. */
  blocked?: string;
}

/** Every accepted header, normalised, pointing at the column it belongs to. */
const HEADER_ALIASES: ReadonlyMap<string, string> = new Map(
  EMPLOYEE_IMPORT_COLUMNS.flatMap((column) => [
    [column.key, column.key] as const,
    ...(column.aliases ?? []).map((alias) => [alias, column.key] as const),
  ]),
);

/** The column a header names, or null when the importer has no use for it. */
export function columnFor(header: string): string | null {
  return HEADER_ALIASES.get(normaliseHeader(header)) ?? null;
}

const GENDERS = ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"];
const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"];
const WORK_MODES = ["ONSITE", "REMOTE", "HYBRID"];
const EMPLOYMENT_STATES = ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"];
// The product's own list, not a copy of it. There were six copies of these
// role names once, and the lesson stuck.
const LOGIN_ROLES: readonly string[] = EMPLOYEE_LOGIN_ROLES;

/**
 * The allowed values for every column that has a fixed set, so the screen can
 * show them instead of making somebody discover them from an error message.
 *
 * Derived from the same arrays the validation uses, because a list on screen
 * that disagrees with the parser is worse than no list.
 */
export const IMPORT_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  gender: GENDERS,
  employmenttype: EMPLOYMENT_TYPES,
  workmode: WORK_MODES,
  employmentstate: EMPLOYMENT_STATES,
  loginrole: LOGIN_ROLES,
  marksownattendance: ["YES", "NO"],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/** Names are matched forgivingly: case and spacing vary between spreadsheets. */
export function lookupKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function planEmployeeImport(
  table: CsvTable,
  lookups: ImportLookups,
  options: { seatsRemaining: number | null } = { seatsRemaining: null },
): ImportPlan {
  // Headers are resolved through the alias map first, so "Emp Code" and
  // "Address" land on the columns they obviously mean.
  const present = new Set(
    table.headers.map((h) => columnFor(h)).filter((k): k is string => k !== null),
  );

  const unknownColumns = table.headers.filter((h) => h !== "" && columnFor(h) === null);
  const missingColumns = EMPLOYEE_IMPORT_COLUMNS.filter(
    (c) => c.required && !present.has(c.key),
  ).map((c) => c.label);

  // Two different headers naming the same field.
  //
  // The parser's own duplicate check cannot see this: `Email` and `Work Email`
  // normalise to two different strings and are only the same column once the
  // alias map has been consulted. A file carrying both used to be accepted,
  // and the second one silently thrown away -- so an organisation that put
  // personal addresses in `Email` and office ones in `Work Email` imported the
  // wrong one for everybody, with nothing on screen to say so.
  const collision = findCollision(table.headers);
  if (collision) {
    return {
      rows: [],
      readyCount: 0,
      errorCount: 0,
      unknownColumns,
      missingColumns: [],
      blocked: `The columns "${collision.first}" and "${collision.second}" are both read as ${collision.label}. Delete or rename one of them, so it is clear which you mean.`,
    };
  }

  if (missingColumns.length > 0) {
    return {
      rows: [],
      readyCount: 0,
      errorCount: 0,
      unknownColumns,
      missingColumns,
      blocked: `The file is missing ${missingColumns.join(", ")}. Download the template and fill that in.`,
    };
  }

  // Every code the file introduces, gathered before any row is validated, so
  // that a manager may appear below the person reporting to them. A spreadsheet
  // is usually sorted by name or by joining date, and requiring managers first
  // would mean rejecting most real files for no reason anybody could act on.
  const fileCodes = new Set<string>();
  for (const row of table.rows) {
    const code = cellFor(row, "employeecode");
    if (code) fileCodes.add(code.toLowerCase());
  }

  // Codes repeated inside the file itself, which the database would only catch
  // one at a time, halfway through.
  const seenCodes = new Map<string, number>();
  const rows = table.rows.map((row) => validateRow(row, lookups, seenCodes, fileCodes));

  const readyCount = rows.filter((r) => r.errors.length === 0).length;
  const errorCount = rows.length - readyCount;

  const plan: ImportPlan = {
    rows,
    readyCount,
    errorCount,
    unknownColumns,
    missingColumns: [],
  };

  if (rows.length === 0) {
    plan.blocked = "That file has a header row and nothing else.";
    return plan;
  }

  // Seats are checked against the whole file, not row by row. Importing 200
  // people into 25 seats has to fail here with the number, not half-import and
  // then start refusing.
  if (options.seatsRemaining !== null && readyCount > options.seatsRemaining) {
    plan.blocked =
      options.seatsRemaining === 0
        ? `There are no seats left, so none of these ${readyCount} people can be added. Buy seats and try again.`
        : `This file would add ${readyCount} people but only ${options.seatsRemaining} seats are free. Buy more seats, or import fewer rows.`;
  }

  return plan;
}

/** Which headers, if any, two of them mean the same column. */
function findCollision(
  headers: readonly string[],
): { first: string; second: string; label: string } | null {
  const seen = new Map<string, string>();
  for (const header of headers) {
    if (header === "") continue;
    const column = columnFor(header);
    if (!column) continue;
    const earlier = seen.get(column);
    if (earlier !== undefined && earlier !== header) {
      const label = EMPLOYEE_IMPORT_COLUMNS.find((c) => c.key === column)?.label ?? column;
      return { first: earlier, second: header, label };
    }
    seen.set(column, header);
  }
  return null;
}

/** One cell of one row, found through the alias map. */
function cellFor(row: CsvRow, key: string): string {
  for (const [header, value] of Object.entries(row.cells)) {
    if (columnFor(header) === key) return value.trim();
  }
  return "";
}

function validateRow(
  row: CsvRow,
  lookups: ImportLookups,
  seenCodes: Map<string, number>,
  fileCodes: ReadonlySet<string>,
): ImportRow {
  const errors: string[] = [];
  // Cells are keyed by the header as written; resolve each one to its column so
  // an aliased header is read from the right place.
  const byColumn: Record<string, string> = {};
  for (const [header, value] of Object.entries(row.cells)) {
    const column = columnFor(header);
    if (column && byColumn[column] === undefined) byColumn[column] = value;
  }
  const get = (key: string) => byColumn[key] ?? "";

  const employeeCode = get("employeecode");
  const firstName = get("firstname");
  const lastName = get("lastname");
  const joiningDate = get("joiningdate");

  if (!employeeCode) {
    errors.push("Employee Code is blank.");
  } else {
    const codeKey = employeeCode.toLowerCase();
    const earlier = seenCodes.get(codeKey);
    if (earlier !== undefined) {
      errors.push(`Employee Code "${employeeCode}" is already used on line ${earlier}.`);
    } else if (lookups.existingCodes.has(codeKey)) {
      errors.push(`Employee Code "${employeeCode}" already belongs to somebody here.`);
    }
    seenCodes.set(codeKey, row.line);
  }

  if (!firstName) errors.push("First Name is blank.");

  if (!joiningDate) {
    errors.push("Joining Date is blank.");
  } else if (!DATE.test(joiningDate) || !isRealDate(joiningDate)) {
    errors.push(`Joining Date "${joiningDate}" is not a real YYYY-MM-DD date.`);
  }

  const dateOfBirth = get("dateofbirth");
  if (dateOfBirth && (!DATE.test(dateOfBirth) || !isRealDate(dateOfBirth))) {
    errors.push(`Date Of Birth "${dateOfBirth}" is not a real YYYY-MM-DD date.`);
  }

  const workEmail = get("workemail");
  if (workEmail && !EMAIL.test(workEmail)) errors.push(`Work Email "${workEmail}" is not an email address.`);
  const personalEmail = get("personalemail");
  if (personalEmail && !EMAIL.test(personalEmail)) {
    errors.push(`Personal Email "${personalEmail}" is not an email address.`);
  }

  const confirmationDate = get("confirmationdate");
  if (confirmationDate && (!DATE.test(confirmationDate) || !isRealDate(confirmationDate))) {
    errors.push(`Permanent From "${confirmationDate}" is not a real YYYY-MM-DD date.`);
  } else if (confirmationDate && joiningDate && confirmationDate < joiningDate) {
    errors.push("Permanent From is before the Joining Date.");
  }

  const annualCtcPaise = parseRupees(get("annualctc"), errors);
  const allowSelfMarking = parseYesNo(get("marksownattendance"), errors);
  const loginRole = pickEnum(get("loginrole"), LOGIN_ROLES, "Login Role", errors);

  // Checked against the file and the directory together, and resolved to an id
  // by the caller once every row has been written.
  const reportsToRaw = get("reportsto");
  let reportsToCode: string | undefined;
  if (reportsToRaw) {
    const key = reportsToRaw.toLowerCase();
    if (key === employeeCode.toLowerCase()) {
      errors.push("Reports To is this person's own Employee Code.");
    } else if (!fileCodes.has(key) && !lookups.existingCodes.has(key)) {
      errors.push(
        `Reports To "${reportsToRaw}" is not an Employee Code in this file or in your directory.`,
      );
    } else {
      reportsToCode = reportsToRaw;
    }
  }

  const gender = pickEnum(get("gender"), GENDERS, "Gender", errors);
  const employmentType = pickEnum(get("employmenttype"), EMPLOYMENT_TYPES, "Employment Type", errors);
  const workMode = pickEnum(get("workmode"), WORK_MODES, "Work Mode", errors);
  const employmentState = pickEnum(get("employmentstate"), EMPLOYMENT_STATES, "Employment State", errors);

  const departmentId = resolve(get("department"), lookups.departments, "Department", errors);
  const designationId = resolve(get("designation"), lookups.designations, "Designation", errors);
  const workLocationId = resolve(get("worklocation"), lookups.workLocations, "Work Location", errors);
  const shiftId = resolve(get("shift"), lookups.shifts, "Shift", errors);
  const weeklyOffPatternId = resolve(
    get("weeklyoffpattern"),
    lookups.weeklyOffPatterns,
    "Weekly Off Pattern",
    errors,
  );

  const name = [firstName, lastName].filter(Boolean).join(" ") || "(no name)";

  if (errors.length > 0) {
    return { line: row.line, employeeCode, name, errors };
  }

  const blank = (value: string) => (value === "" ? null : value);

  return {
    line: row.line,
    employeeCode,
    name,
    errors,
    employee: {
      employeeCode,
      firstName,
      lastName: blank(lastName),
      joiningDate,
      workEmail: blank(workEmail),
      personalEmail: blank(personalEmail),
      phone: blank(get("phone")),
      gender,
      dateOfBirth: blank(dateOfBirth),
      ...(employmentType ? { employmentType } : {}),
      ...(workMode ? { workMode } : {}),
      ...(employmentState ? { employmentState } : {}),
      confirmationDate: blank(confirmationDate),
      // Tri-state: undefined here becomes null on the row, which means "follow
      // the organisation" and is not the same as an explicit no.
      allowSelfMarking: allowSelfMarking ?? null,
      departmentId,
      designationId,
      workLocationId,
      shiftId,
      weeklyOffPatternId,
      addressLine1: blank(get("addressline1")),
      city: blank(get("city")),
      state: blank(get("state")),
      postalCode: blank(get("postalcode")),
      emergencyName: blank(get("emergencyname")),
      emergencyPhone: blank(get("emergencyphone")),
      emergencyRelation: blank(get("emergencyrelation")),
      bloodGroup: blank(get("bloodgroup")),
      pan: blank(get("pan")),
      aadhaar: blank(get("aadhaar")),
      bankName: blank(get("bankname")),
      bankAccount: blank(get("bankaccount")),
      bankIfsc: blank(get("bankifsc")),
      uan: blank(get("uan")),
    },
    ...(annualCtcPaise !== undefined ? { annualCtcPaise } : {}),
    ...(reportsToCode !== undefined ? { reportsToCode } : {}),
    ...(loginRole !== undefined ? { loginRole } : {}),
  };
}

/**
 * A rupee figure as somebody types it into a spreadsheet, in paise.
 *
 * "660000", "6,60,000", "Rs 660000", "660000.00" and "660,000" all arrive, and
 * all mean the same thing. Paise because money is integer paise everywhere in
 * this product, and the conversion is done with a rounded multiply rather than
 * a float multiply -- 6600.07 * 100 is 660006.9999999999.
 */
function parseRupees(value: string, errors: string[]): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\s,]/g, "").replace(/^(rs\.?|inr|\u20B9)/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    errors.push(`Annual CTC "${value}" is not an amount. Write it in rupees, e.g. 660000.`);
    return undefined;
  }
  const paise = Math.round(Number(cleaned) * 100);
  if (paise <= 0) {
    errors.push("Annual CTC is zero. Leave it blank instead, and set pay from the salary screen.");
    return undefined;
  }
  if (paise > 100_000_000_000) {
    errors.push(`Annual CTC "${value}" is larger than this product will accept.`);
    return undefined;
  }
  return paise;
}

/** YES / NO, and the half-dozen ways people write them. Blank stays undefined. */
function parseYesNo(value: string, errors: string[]): boolean | undefined {
  if (!value) return undefined;
  const word = value.trim().toUpperCase();
  if (["YES", "Y", "TRUE", "1"].includes(word)) return true;
  if (["NO", "N", "FALSE", "0"].includes(word)) return false;
  errors.push(`Marks Own Attendance "${value}" is not YES or NO.`);
  return undefined;
}

function pickEnum(
  value: string,
  allowed: readonly string[],
  label: string,
  errors: string[],
): string | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!allowed.includes(upper)) {
    errors.push(`${label} "${value}" is not one of ${allowed.join(", ")}.`);
    return undefined;
  }
  return upper;
}

function resolve(
  value: string,
  table: ReadonlyMap<string, string>,
  label: string,
  errors: string[],
): string | null {
  if (!value) return null;
  const id = table.get(lookupKey(value));
  if (!id) {
    errors.push(`${label} "${value}" does not exist yet. Create it first, or clear the cell.`);
    return null;
  }
  return id;
}

/** `2026-02-30` matches the pattern and is still not a day. */
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/**
 * What the organisation already has, for the columns that must name something
 * real. The template fills its example rows with these rather than with invented
 * names, so a downloaded file can be imported as it stands.
 */
export interface TemplateReference {
  department?: string;
  designation?: string;
  workLocation?: string;
  shift?: string;
  weeklyOffPattern?: string;
}

/**
 * The header row and two complete example rows.
 *
 * Two, not one, and in this order on purpose. The first reports to the second,
 * which demonstrates the thing nobody would guess -- that a manager may appear
 * below the person reporting to them -- and gives a downloaded template
 * something a person can import unchanged to see what happens.
 *
 * Every column carries a value. The old template filled thirteen of thirty-one
 * and left the rest blank, which read as "these are not really used".
 */
export function importTemplateRows(reference: TemplateReference = {}): string[][] {
  const rows = [MANAGED_EXAMPLE, MANAGER_EXAMPLE].map((example) =>
    EMPLOYEE_IMPORT_COLUMNS.map((c) => {
      const referenced = REFERENCE_COLUMNS[c.key];
      // A reference column is only filled when the organisation actually has
      // one of those. Naming a department that does not exist would fail the
      // row, and the file is meant to be importable as it arrives.
      if (referenced) return reference[referenced] ?? "";
      return example[c.key] ?? "";
    }),
  );
  return [EMPLOYEE_IMPORT_COLUMNS.map((c) => c.label), ...rows];
}

const REFERENCE_COLUMNS: Record<string, keyof TemplateReference | undefined> = {
  department: "department",
  designation: "designation",
  worklocation: "workLocation",
  shift: "shift",
  weeklyoffpattern: "weeklyOffPattern",
};

const MANAGED_EXAMPLE: Record<string, string> = {
  employeecode: "EXAMPLE-002",
  firstname: "Asha",
  lastname: "Rao",
  joiningdate: "2026-04-01",
  workemail: "asha.rao@example.com",
  personalemail: "asha.rao@personalmail.example",
  phone: "+91 98765 43210",
  gender: "FEMALE",
  dateofbirth: "1996-07-14",
  employmenttype: "FULL_TIME",
  workmode: "ONSITE",
  employmentstate: "PROBATION",
  confirmationdate: "2026-10-01",
  // Below them in this file, which is allowed.
  reportsto: "EXAMPLE-001",
  annualctc: "660000",
  loginrole: "TEAM_MEMBER",
  marksownattendance: "YES",
  addressline1: "12 Bailey Road",
  city: "Patna",
  state: "Bihar",
  postalcode: "800014",
  emergencyname: "Sunita Rao",
  emergencyphone: "+91 98765 11111",
  emergencyrelation: "Mother",
  bloodgroup: "O+",
  pan: "ABCDE1234F",
  aadhaar: "1234",
  bankname: "State Bank of India",
  bankaccount: "30123456789",
  bankifsc: "SBIN0001234",
  uan: "100123456789",
};

const MANAGER_EXAMPLE: Record<string, string> = {
  employeecode: "EXAMPLE-001",
  firstname: "Vikram",
  lastname: "Nair",
  joiningdate: "2024-01-15",
  workemail: "vikram.nair@example.com",
  personalemail: "vikram.nair@personalmail.example",
  phone: "+91 98765 43211",
  gender: "MALE",
  dateofbirth: "1988-02-09",
  employmenttype: "FULL_TIME",
  workmode: "HYBRID",
  employmentstate: "CONFIRMED",
  confirmationdate: "2024-07-15",
  reportsto: "",
  annualctc: "1440000",
  loginrole: "MANAGER",
  marksownattendance: "",
  addressline1: "4 Boring Road",
  city: "Patna",
  state: "Bihar",
  postalcode: "800001",
  emergencyname: "Meera Nair",
  emergencyphone: "+91 98765 22222",
  emergencyrelation: "Spouse",
  bloodgroup: "B+",
  pan: "PQRST5678K",
  aadhaar: "5678",
  bankname: "HDFC Bank",
  bankaccount: "50100987654321",
  bankifsc: "HDFC0000123",
  uan: "100987654321",
};

/**
 * Every column, with what it is for and what it will accept.
 *
 * The hints have existed on the columns since the importer was written and were
 * rendered by nothing, so the allowed values for Gender, Employment Type, Work
 * Mode and Employment State were discoverable only by getting them wrong. This
 * is the same list the parser matches against, so the screen and the file
 * cannot disagree.
 */
export function importColumnGuide(): {
  key: string;
  label: string;
  required: boolean;
  hint: string | null;
  values: readonly string[] | null;
}[] {
  return EMPLOYEE_IMPORT_COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    required: c.required === true,
    hint: c.hint ?? null,
    values: IMPORT_ENUM_VALUES[c.key] ?? null,
  }));
}
