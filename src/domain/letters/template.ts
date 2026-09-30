/**
 * Letter templates.
 *
 * A template is text with `{{placeholders}}`. The rules here are deliberately
 * strict in one direction and forgiving in the other: an unknown placeholder is
 * an error the author must see, but a *missing value* for a known placeholder
 * is reported rather than silently rendered as "undefined" — a letter that goes
 * out saying "Dear undefined" is worse than one that refuses to render.
 */

export interface Placeholder {
  key: string;
  label: string;
  /** Where the value comes from, for the editor's help text. */
  hint: string;
}

/**
 * Everything a letter may refer to.
 *
 * Kept as an explicit catalogue rather than "any employee field" so that adding
 * a column to the database does not silently make private data addressable from
 * a template.
 */
export const PLACEHOLDERS: readonly Placeholder[] = [
  { key: "employee.name", label: "Employee name", hint: "Full name" },
  { key: "employee.code", label: "Employee code", hint: "e.g. ACM007" },
  { key: "employee.designation", label: "Designation", hint: "Job title" },
  { key: "employee.department", label: "Department", hint: "Department name" },
  { key: "employee.joiningDate", label: "Joining date", hint: "Date they started" },
  { key: "employee.email", label: "Employee email", hint: "Work email" },
  { key: "employee.phone", label: "Employee phone", hint: "Contact number" },
  { key: "employee.location", label: "Work location", hint: "Office they are attached to" },
  { key: "employee.manager", label: "Reporting manager", hint: "Primary manager's name" },
  { key: "salary.monthlyCtc", label: "Monthly salary", hint: "Current monthly CTC, formatted" },
  { key: "salary.annualCtc", label: "Annual salary", hint: "Twelve months of CTC, formatted" },
  { key: "organization.name", label: "Organisation name", hint: "Your organisation" },
  { key: "organization.legalName", label: "Registered name", hint: "Legal entity name" },
  { key: "organization.address", label: "Organisation address", hint: "Registered address" },
  { key: "organization.email", label: "Organisation email", hint: "Contact address" },
  { key: "organization.phone", label: "Organisation phone", hint: "Contact number" },
  { key: "organization.website", label: "Organisation website", hint: "Public website" },
  // Statutory identifiers. An appointment letter that has to quote a CIN had
  // nowhere to get one before these existed on the organisation.
  { key: "organization.cin", label: "CIN", hint: "Corporate identity number" },
  { key: "organization.gstin", label: "GSTIN", hint: "GST registration" },
  { key: "organization.pan", label: "Company PAN", hint: "The organisation's PAN" },
  { key: "organization.tan", label: "TAN", hint: "Tax deduction account number" },
  { key: "organization.pfCode", label: "PF code", hint: "EPF establishment code" },
  { key: "organization.esiCode", label: "ESI code", hint: "ESIC establishment code" },
  // The terms an appointment letter is expected to state. Two are answered
  // from the organisation's own settings; the notice period is not stored
  // anywhere in this product and is therefore always asked for, which is what
  // stops a default letter from quietly inventing one.
  {
    key: "terms.probationPeriod",
    label: "Probation period",
    hint: "From the organisation's probation setting",
  },
  {
    key: "terms.workingHours",
    label: "Working hours",
    hint: "From the shift this person is on, or the organisation's default shift",
  },
  // Dates a letter needs and the record can answer. Until these existed the
  // catalogue held exactly one date about a person -- their joining date -- so
  // an experience certificate could say when somebody started and had no way to
  // say when they left, which is the one fact it exists to state.
  {
    key: "employee.lastWorkingDay",
    label: "Last working day",
    hint: "From their exit record",
  },
  {
    key: "employee.confirmationDate",
    label: "Confirmation date",
    hint: "The day probation ended",
  },
  {
    key: "employee.tenure",
    label: "Length of service",
    hint: "Joining date to last working day",
  },
  {
    key: "salary.previousMonthlyCtc",
    label: "Previous monthly salary",
    hint: "The salary before the current one",
  },
  {
    key: "salary.previousAnnualCtc",
    label: "Previous annual salary",
    hint: "Twelve months of the previous CTC",
  },
  {
    key: "terms.effectiveDate",
    label: "Effective from",
    hint: "Typed when the letter is issued -- a promotion's date is a decision, not a record",
  },
  {
    key: "terms.noticePeriod",
    label: "Notice period",
    hint: "Not stored anywhere -- type it when you issue the letter",
  },
  { key: "letter.date", label: "Letter date", hint: "Date of issue" },
  { key: "letter.number", label: "Letter number", hint: "Reference number" },
  { key: "signatory.name", label: "Signatory name", hint: "Who signs it" },
  { key: "signatory.title", label: "Signatory title", hint: "Their designation" },
];

const PLACEHOLDER_KEYS = new Set(PLACEHOLDERS.map((p) => p.key));

/** Matches `{{ key }}` with any spacing. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * A value that is *legitimately* absent, as opposed to missing.
 *
 * The distinction matters because the two need opposite treatment. A missing
 * value stops the letter: an offer that prints "[Monthly salary]" is not a
 * document anybody should send. A value that does not apply should simply not
 * be mentioned -- an organisation with no provident fund has no establishment
 * code, and demanding one before it can issue an appointment letter is the
 * product asking somebody to invent a fact about their own company.
 *
 * A placeholder resolving to this **drops the paragraph it stands in**, whole.
 * Paragraphs are the unit because a statutory clause is a sentence or two about
 * one subject, and deleting the placeholder alone would leave "contributions
 * are made under establishment code ." behind.
 */
export const NOT_APPLICABLE = "\u0000not-applicable";

export type LetterValues = Record<string, string | null | undefined>;

export interface RenderProblem {
  key: string;
  kind: "UNKNOWN" | "MISSING";
  message: string;
}

export interface RenderedLetter {
  text: string;
  problems: RenderProblem[];
  /** Placeholders the template actually uses, in order of first appearance. */
  used: string[];
}

/**
 * Fills a template.
 *
 * Always returns text — even with problems — so an editor can show a preview
 * alongside the list of what is wrong. Whether that text may be *issued* is a
 * separate decision, made by `canIssue`.
 */
export function renderTemplate(template: string, values: LetterValues): RenderedLetter {
  const problems: RenderProblem[] = [];
  const used: string[] = [];
  const seen = new Set<string>();
  /** Keys already reported, so one placeholder never produces two problems. */
  const reported = new Set<string>();
  /** Set while rendering a paragraph that turns out not to apply. */
  let paragraphDropped = false;

  const renderOne = (template: string): string =>
    template.replace(TOKEN, (match, rawKey: string) => {
    const key = rawKey.trim();

    if (!seen.has(key)) {
      seen.add(key);
      used.push(key);
    }

    if (!PLACEHOLDER_KEYS.has(key)) {
      // One problem per *key*, not per occurrence. The composer renders one
      // input per problem, so a placeholder appearing twice produced two
      // identical fields with the same DOM id and the same React key, both
      // writing to one value. `{{organization.name}}` appears twice in the
      // shipped Offer default and three times in the Appointment one, so this
      // was the normal case rather than an edge.
      if (!reported.has(key)) {
        reported.add(key);
        problems.push({
          key,
          kind: "UNKNOWN",
          message: `“${key}” is not a placeholder this system knows about.`,
        });
      }
      // Left in place rather than blanked, so the author can see where it was.
      return match;
    }

    const value = values[key];
    if (value === undefined || value === null || value === "") {
      if (!reported.has(key)) {
        reported.add(key);
        problems.push({
          key,
          kind: "MISSING",
          message: `No value available for “${label(key)}”.`,
        });
      }
      return `[${label(key)}]`;
    }

      if (value === NOT_APPLICABLE) {
        // Not a problem, and not text either: the paragraph goes.
        paragraphDropped = true;
        return "";
      }

      return value;
    });

  /**
   * Rendered paragraph by paragraph, so one that does not apply can be dropped
   * without disturbing the rest.
   *
   * `used` and `problems` still cover the whole template, including dropped
   * paragraphs -- the fill-in form is built from the template, not from what
   * survived this particular render, and a placeholder that vanishes for one
   * organisation must not vanish from the editor for everybody.
   */
  const text = template
    .split(/\n{2,}/)
    .map((paragraph) => {
      paragraphDropped = false;
      const rendered = renderOne(paragraph);
      return paragraphDropped ? null : rendered;
    })
    .filter((paragraph): paragraph is string => paragraph !== null)
    .join("\n\n");

  return { text, problems, used };
}

function label(key: string): string {
  return PLACEHOLDERS.find((p) => p.key === key)?.label ?? key;
}

/**
 * Whether a rendered letter is safe to issue.
 *
 * Unknown placeholders block: they mean the template is wrong. Missing values
 * block too — an offer letter with "[Monthly salary]" printed on it is not a
 * document anybody should be sending.
 */
export function canIssue(rendered: RenderedLetter): boolean {
  return rendered.problems.length === 0;
}

/** Placeholders a template refers to, for storing alongside it. */
export function extractPlaceholders(template: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    const key = match[1]!.trim();
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * The next letter number for an organisation.
 *
 * Sequential per year and prefix, because letter numbers are quoted in
 * correspondence and a gap invites the question "what happened to number 14?".
 */
export function nextLetterNumber(prefix: string, year: number, lastNumber: string | null): string {
  const pad = (n: number) => String(n).padStart(4, "0");
  if (!lastNumber) return `${prefix}/${year}/${pad(1)}`;

  const match = new RegExp(`^${escapeRegExp(prefix)}/${year}/(\\d+)$`).exec(lastNumber);
  const next = match ? Number(match[1]) + 1 : 1;
  return `${prefix}/${year}/${pad(next)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const LETTER_CATEGORIES = [
  "OFFER",
  "APPOINTMENT",
  "CONFIRMATION",
  "PROMOTION",
  "INCREMENT",
  "WARNING",
  "EXPERIENCE",
  "RELIEVING",
  "TERMINATION",
  "OTHER",
] as const;

export type LetterCategory = (typeof LETTER_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<LetterCategory, string> = {
  OFFER: "Offer letter",
  APPOINTMENT: "Appointment letter",
  CONFIRMATION: "Confirmation letter",
  PROMOTION: "Promotion letter",
  INCREMENT: "Increment letter",
  WARNING: "Warning letter",
  EXPERIENCE: "Experience certificate",
  RELIEVING: "Relieving letter",
  TERMINATION: "Termination letter",
  OTHER: "Other",
};

/** Short prefix used in letter numbers, so the category is readable at a glance. */
export const CATEGORY_PREFIX: Record<LetterCategory, string> = {
  OFFER: "OFR",
  APPOINTMENT: "APT",
  CONFIRMATION: "CNF",
  PROMOTION: "PRM",
  INCREMENT: "INC",
  WARNING: "WRN",
  EXPERIENCE: "EXP",
  RELIEVING: "REL",
  TERMINATION: "TRM",
  OTHER: "LTR",
};
