import type { LetterStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { probationPeriod, tenureBetween } from "@/domain/letters/terms";
import { prisma } from "@/lib/db/prisma";
import { DEFAULT_CODE_PREFIX, normaliseCodePrefix } from "@/domain/employees/code";
import { getPayrollPolicy } from "@/services/policy";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { storage } from "@/lib/storage";
import { toPdfSafeText } from "@/lib/pdf/fonts";
import { formatPaise } from "@/domain/money";
import { type DateOnly, todayInZone } from "@/domain/date";
import {
  CATEGORY_LABELS,
  CATEGORY_PREFIX,
  type LetterCategory,
  type LetterValues,
  type RenderProblem,
  canIssue,
  extractPlaceholders,
  nextLetterNumber,
  renderTemplate,
  NOT_APPLICABLE,
} from "@/domain/letters/template";
import { LETTER_DEFAULTS } from "@/domain/letters/defaults";
import { documentHeader } from "@/lib/pdf/orgHeader";
import { storedImageDataUri } from "@/lib/pdf/orgLogo";
import { renderLetterPdf } from "@/lib/pdf/letter";

/**
 * Letters.
 *
 * The lifecycle is deliberately two-stage: a letter is composed as a DRAFT and
 * only becomes ISSUED when a person presses issue, at which point the PDF is
 * rendered once and stored. After that the text is frozen — an issued letter
 * that can still be edited is not evidence of anything, and people quote these
 * to banks and immigration officers.
 *
 * AI drafts land as DRAFT like any other, with the prompt and model recorded.
 */

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function formatLongDate(date: DateOnly): string {
  const [y, m, d] = date.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${String(d).padStart(2, "0")} ${months[(m ?? 1) - 1]} ${y}`;
}

// ------------------------------------------------------------------ values

/**
 * Everything a template may refer to, for one employee.
 *
 * Assembled here rather than in the template layer so the domain code stays
 * free of Prisma — and so exactly one place decides what a letter is allowed to
 * know about somebody.
 */
export async function letterValues(
  ctx: AuthContext,
  employeeId: string,
  letter: { number?: string; date?: DateOnly; signatory?: { name?: string | null; title?: string | null } } = {},
): Promise<LetterValues> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: ctx.organizationId! },
    select: {
      employeeCode: true,
      joiningDate: true,
      phone: true,
      // Read off the employee record, not their login.
      //
      // These used to come from `user.name` and `user.email`, and until logins
      // existed no employee had a user at all — so every letter rendered "Dear
      // [Employee name]" and `canIssue` refused it, because a missing value for
      // a known placeholder is a problem. The name of a person is a property of
      // the person, not of whether they can sign in.
      firstName: true,
      lastName: true,
      workEmail: true,
      personalEmail: true,
      designation: { select: { title: true } },
      department: { select: { name: true } },
      workLocation: { select: { name: true } },
      shift: { select: { startTime: true, endTime: true } },
      managers: {
        where: { type: "PRIMARY" },
        take: 1,
        select: { manager: { select: { firstName: true, lastName: true } } },
      },
      confirmationDate: true,
      exitRecord: { select: { lastWorkingDay: true } },
      // Two, not one: the profile in force today and the one it replaced, so an
      // increment letter can say what the salary was as well as what it becomes.
      // An increment that states only the new figure is the half of the sentence
      // nobody is checking.
      salaryProfiles: {
        orderBy: { effectiveFrom: "desc" },
        take: 2,
        select: { ctcMonthlyPaise: true, effectiveFrom: true, effectiveTo: true },
      },
    },
  });
  if (!employee) throw new NotFoundError("That employee");

  const organization = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: {
      name: true,
      legalName: true,
      email: true,
      phone: true,
      website: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      cin: true,
      gstin: true,
      panNumber: true,
      tan: true,
      pfCode: true,
      esiCode: true,
      probationDays: true,
    },
  });

  /**
   * Whether this organisation actually runs PF and ESI.
   *
   * The appointment letter states both unconditionally, and this file never
   * read the payroll policy at all -- so an organisation with PF switched off
   * had no establishment code, the placeholder was unresolved, and the
   * appointment letter **could not be issued at all** until somebody typed a
   * code they do not have. Reading the policy turns that from a blocker into a
   * paragraph that simply is not there, and switching PF on in payroll brings
   * the clause back with no letter editing.
   *
   * `isDefault` is not consulted deliberately: the shipped policy has both off,
   * and an organisation that has never opened the payroll settings genuinely
   * does not run either.
   */
  const { policy: payroll } = await getPayrollPolicy(ctx);
  const statutory = {
    pf: payroll.statutory.providentFund.enabled,
    esi: payroll.statutory.esi.enabled,
  };

  // The hours this person is actually attached to, or the organisation's
  // default shift when nobody has assigned them one. Left null rather than
  // guessed at when the organisation has no default either -- an appointment
  // letter that states hours nobody configured is a made-up clause, and the
  // fill-in form refuses to issue a letter with an unresolved placeholder.
  const shift =
    employee.shift ??
    (await prisma.shift.findFirst({
      where: { organizationId: ctx.organizationId!, isDefault: true, active: true },
      select: { startTime: true, endTime: true },
    }));

  const monthly = employee.salaryProfiles[0]?.ctcMonthlyPaise ?? null;
  const previousMonthly = employee.salaryProfiles[1]?.ctcMonthlyPaise ?? null;
  const lastWorkingDay = employee.exitRecord?.lastWorkingDay ?? null;
  // The full registered address, country included.
  //
  // `country` was left out here while the letterhead printed it, so a letter
  // could carry two different versions of the same organisation's address — the
  // complete one at the top and a truncated one wherever the body used
  // `{{organization.address}}`.
  const address = [
    organization?.addressLine1,
    organization?.addressLine2,
    organization?.city,
    organization?.state,
    organization?.postalCode,
    organization?.country,
  ]
    .filter(Boolean)
    .join(", ");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  const fullName = (first: string, last: string | null) =>
    [first, last].filter(Boolean).join(" ");

  return {
    "employee.name": fullName(employee.firstName, employee.lastName),
    "employee.code": employee.employeeCode,
    "employee.designation": employee.designation?.title ?? null,
    "employee.department": employee.department?.name ?? null,
    "employee.joiningDate": employee.joiningDate ? formatLongDate(toDateOnly(employee.joiningDate)) : null,
    "employee.email": employee.workEmail ?? employee.personalEmail ?? null,
    "employee.phone": employee.phone ?? null,
    "employee.location": employee.workLocation?.name ?? null,
    "employee.manager": employee.managers[0]
      ? fullName(employee.managers[0].manager.firstName, employee.managers[0].manager.lastName)
      : null,
    // The screen formatter, not the PDF one. These values are shown in the
    // composer as well as printed, and the composer can draw a rupee sign
    // perfectly well; the PDF is made safe at its own boundary above, which is
    // the only place that knows whether the font is there.
    "salary.monthlyCtc": monthly != null ? formatPaise(monthly) : null,
    "salary.annualCtc": monthly != null ? formatPaise(monthly * 12) : null,
    "organization.name": organization?.name ?? null,
    "organization.legalName": organization?.legalName ?? organization?.name ?? null,
    "organization.address": address || null,
    "organization.email": organization?.email ?? null,
    "organization.phone": organization?.phone ?? null,
    "organization.website": organization?.website ?? null,
    "organization.cin": organization?.cin ?? null,
    "organization.gstin": organization?.gstin ?? null,
    "organization.pan": organization?.panNumber ?? null,
    "organization.tan": organization?.tan ?? null,
    // Off in payroll means the clause does not apply, which is different from
    // an establishment code somebody has not filled in yet: the first drops the
    // paragraph, the second stops the letter until it is answered.
    "organization.pfCode": statutory.pf ? (organization?.pfCode ?? null) : NOT_APPLICABLE,
    "organization.esiCode": statutory.esi ? (organization?.esiCode ?? null) : NOT_APPLICABLE,
    "employee.lastWorkingDay": lastWorkingDay ? formatLongDate(toDateOnly(lastWorkingDay)) : null,
    "employee.confirmationDate": employee.confirmationDate
      ? formatLongDate(toDateOnly(employee.confirmationDate))
      : null,
    "employee.tenure":
      employee.joiningDate && lastWorkingDay
        ? tenureBetween(toDateOnly(employee.joiningDate), toDateOnly(lastWorkingDay))
        : null,
    "salary.previousMonthlyCtc": previousMonthly != null ? formatPaise(previousMonthly) : null,
    "salary.previousAnnualCtc":
      previousMonthly != null ? formatPaise(previousMonthly * 12) : null,
    // Never resolved from a record. When a promotion or an increment takes
    // effect is a decision somebody makes on the day, not something the database
    // knows -- and an unresolved placeholder stops the letter rather than
    // printing a date nobody chose.
    "terms.effectiveDate": null,
    "terms.probationPeriod": probationPeriod(organization?.probationDays ?? null),
    "terms.workingHours": shift ? `${shift.startTime} to ${shift.endTime}` : null,
    // Deliberately absent. Nothing in this product stores an employment notice
    // period -- `LeaveType.noticeDays` is how far ahead leave must be applied
    // for, and `ExitRecord.noticeDaysRequired` is decided when somebody
    // resigns, long after an offer is signed. So it is asked for every time.
    "terms.noticePeriod": null,
    "letter.date": formatLongDate(letter.date ?? today),
    "letter.number": letter.number ?? null,
    "signatory.name": letter.signatory?.name ?? ctx.name ?? null,
    "signatory.title": letter.signatory?.title ?? null,
  };
}

/**
 * What to offer when a placeholder has to be typed.
 *
 * The fill-in form asks for a value whenever the employee record has none, and
 * it asked with an empty text box — so "Department" was a free-text field on a
 * legal document, in an organisation that has a list of departments sitting
 * right there. Two people filling the same gap wrote "Engineering" and "Engg".
 *
 * Suggestions, not a constraint: the box still accepts anything, because a
 * letter sometimes has to say something the org chart does not contain, and a
 * dropdown that cannot be escaped would send somebody to the settings screen to
 * add a department they do not want.
 *
 * Gated on `letter.issue` rather than on the employee-admin permission, so
 * whoever can issue a letter can see the lists it needs. They are names of
 * structures, not anybody's personal data — except the manager list, which is
 * the same set of names the letter is about to print anyway.
 */
export async function letterSuggestions(ctx: AuthContext): Promise<Record<string, string[]>> {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");

  const org = { organizationId: ctx.organizationId!, active: true };
  const [departments, designations, locations, managers] = await Promise.all([
    prisma.department.findMany({ where: org, select: { name: true }, orderBy: { name: "asc" } }),
    prisma.designation.findMany({ where: org, select: { title: true }, orderBy: { title: "asc" } }),
    prisma.workLocation.findMany({ where: org, select: { name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({
      where: {
        organizationId: ctx.organizationId!,
        active: true,
        employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
      },
      select: { firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);

  return {
    "employee.department": departments.map((d) => d.name),
    "employee.designation": designations.map((d) => d.title),
    "employee.location": locations.map((l) => l.name),
    "employee.manager": managers.map((m) => [m.firstName, m.lastName].filter(Boolean).join(" ")),
  };
}

// ------------------------------------------------------------------ preview

/**
 * Who this letter is signed by, before anybody types anything.
 *
 * Configured on the framework first, then whoever is issuing it, then their own
 * designation off their employee record. Shared by the preview and the issue so
 * the two cannot disagree — the compose screen used to show `ctx.name` with no
 * title while the issued PDF used the framework's, and nobody could see the
 * difference until the letter was already out.
 */
export async function signatoryFrom(
  ctx: AuthContext,
  framework: { signatoryName: string | null; signatoryTitle: string | null },
): Promise<{ name: string | null; title: string | null }> {
  const issuerTitle = ctx.employeeId
    ? ((
        await prisma.employee.findUnique({
          where: { id: ctx.employeeId },
          select: { designation: { select: { title: true } } },
        })
      )?.designation?.title ?? null)
    : null;

  return {
    name: framework.signatoryName ?? ctx.name ?? null,
    title: framework.signatoryTitle ?? issuerTitle,
  };
}

/** The same answer, for a caller that has not already loaded the framework. */
export async function resolveSignatory(ctx: AuthContext, category: string) {
  return signatoryFrom(ctx, await frameworkFor(ctx, category));
}

export async function previewLetter(
  ctx: AuthContext,
  input: {
    employeeId: string;
    body: string;
    category: string;
    /** What the author typed into the fill-in form; wins over the record. */
    filled?: Record<string, string>;
  },
) {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");

  const signatory = await resolveSignatory(ctx, input.category);
  const fromRecord = await letterValues(ctx, input.employeeId, {
    number: `${CATEGORY_PREFIX[input.category as LetterCategory] ?? "LTR"}/…/…`,
    signatory,
  });
  const values = { ...fromRecord, ...(input.filled ?? {}) };
  const rendered = renderTemplate(input.body, values);

  return {
    text: rendered.text,
    problems: rendered.problems,
    used: rendered.used,
    canIssue: canIssue(rendered),
    // Returned so the compose screen can show the signatory as two pre-filled
    // boxes rather than leaving somebody to discover it on the printed page.
    // These are what `values` resolved to, so they already carry anything typed.
    signatory: {
      name: values["signatory.name"] ?? null,
      title: values["signatory.title"] ?? null,
    },
  };
}

// ------------------------------------------------------------------ listing

export interface LetterRow {
  id: string;
  letterNumber: string;
  category: string;
  categoryLabel: string;
  subject: string;
  status: LetterStatus;
  issuedOn: DateOnly | null;
  aiGenerated: boolean;
  aiModel: string | null;
  hasPdf: boolean;
  pdfUrl: string | null;
  employee: { id: string; name: string; code: string };
  createdAt: string;
}

export async function listLetters(
  ctx: AuthContext,
  filters: { employeeId?: string; status?: LetterStatus } = {},
): Promise<LetterRow[]> {
  requireOrg(ctx);

  const where: Record<string, unknown> = { organizationId: ctx.organizationId };

  // Someone with only `letter.read.self` sees their own issued letters and
  // nothing else — including none of the drafts about them.
  if (!ctx.permissions.has("letter.read.all")) {
    requirePermission(ctx, "letter.read.self");
    where.employeeId = ctx.employeeId ?? "";
    where.status = { in: ["ISSUED"] };
  } else {
    const visible = await visibleEmployeeIds(ctx, "letter.read");
    if (visible !== null) where.employeeId = { in: visible };
    if (filters.status) where.status = filters.status;
  }

  if (filters.employeeId && ctx.permissions.has("letter.read.all")) {
    where.employeeId = filters.employeeId;
  }

  const letters = await prisma.letter.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      letterNumber: true,
      category: true,
      subject: true,
      status: true,
      issuedOn: true,
      aiGenerated: true,
      aiModel: true,
      fileKey: true,
      createdAt: true,
      employee: {
        select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
      },
    },
  });

  return letters.map((l) => ({
    id: l.id,
    letterNumber: l.letterNumber,
    category: l.category,
    categoryLabel: CATEGORY_LABELS[l.category as LetterCategory] ?? l.category,
    subject: l.subject,
    status: l.status,
    issuedOn: l.issuedOn ? toDateOnly(l.issuedOn) : null,
    aiGenerated: l.aiGenerated,
    aiModel: l.aiModel,
    hasPdf: Boolean(l.fileKey),
    pdfUrl: l.fileKey ? `/api/files/${l.fileKey}` : null,
    employee: {
      id: l.employee.id,
      name: employeeName(l.employee, "—"),
      code: l.employee.employeeCode,
    },
    createdAt: l.createdAt.toISOString(),
  }));
}

export async function getLetter(ctx: AuthContext, id: string) {
  requireOrg(ctx);

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } } },
    },
  });
  if (!letter) throw new NotFoundError("That letter");

  // Cross-tenant and out-of-scope reads look identical to "does not exist".
  if (!ctx.permissions.has("letter.read.all")) {
    requirePermission(ctx, "letter.read.self");
    if (letter.employeeId !== ctx.employeeId || letter.status !== "ISSUED") {
      throw new NotFoundError("That letter");
    }
  }

  return {
    ...letter,
    issuedOn: letter.issuedOn ? toDateOnly(letter.issuedOn) : null,
    categoryLabel: CATEGORY_LABELS[letter.category as LetterCategory] ?? letter.category,
    pdfUrl: letter.fileKey ? `/api/files/${letter.fileKey}` : null,
  };
}

// ------------------------------------------------------------------ drafting

export interface CreateLetterInput {
  employeeId: string;
  category: string;
  subject: string;
  body: string;
  templateId?: string;
  aiPrompt?: string;
  aiModel?: string;
  /**
   * Values typed into the fill-in form beside the editor.
   *
   * Placeholders whose value no column can supply — a notice period, a reason,
   * a date that is not the joining date — used to make a letter permanently
   * unissuable, because `canIssue` requires every one of them to resolve.
   */
  filled?: Record<string, string>;
}

export async function createLetter(ctx: AuthContext, input: CreateLetterInput) {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  const category = input.category as LetterCategory;
  /**
   * The organisation's own mark, then the kind of letter.
   *
   * `OFR/2026/0001` said what the letter was and nothing about who issued it,
   * and two organisations on the same instance both had an OFR/2026/0001. The
   * prefix an organisation chooses now leads every number it hands out, so a
   * number quoted in an email identifies the company as well as the document.
   *
   * Letters already issued keep the numbers printed on them: the series is
   * found by matching the prefix, so the new shape starts its own count. That
   * is the honest outcome -- renumbering a letter somebody has already been
   * sent would be worse than a visible change of format.
   */
  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { employeeCodePrefix: true },
  });
  const prefix = `${normaliseCodePrefix(org?.employeeCodePrefix ?? DEFAULT_CODE_PREFIX)}/${
    CATEGORY_PREFIX[category] ?? "LTR"
  }`;
  const year = Number(todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata").slice(0, 4));

  // Numbers are handed out at draft time so the number can appear in the body.
  const last = await prisma.letter.findFirst({
    where: { organizationId: ctx.organizationId, letterNumber: { startsWith: `${prefix}/${year}/` } },
    orderBy: { letterNumber: "desc" },
    select: { letterNumber: true },
  });

  const letter = await prisma.letter.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId: input.employeeId,
      templateId: input.templateId ?? null,
      letterNumber: nextLetterNumber(prefix, year, last?.letterNumber ?? null),
      category: input.category,
      subject: input.subject.trim(),
      body: input.body,
      status: "DRAFT",
      aiGenerated: Boolean(input.aiPrompt),
      aiPrompt: input.aiPrompt ?? null,
      aiModel: input.aiModel ?? null,
      variables: {
        placeholders: extractPlaceholders(input.body),
        // What a person typed into the fill-in form. Merged over the record at
        // issue time, so a value the database cannot supply — a notice period,
        // a reason, a date that is not the joining date — still reaches the PDF
        // instead of blocking the letter for ever.
        filled: input.filled ?? {},
      },
      createdById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "letter.generated",
    entityType: "Letter",
    entityId: letter.id,
    after: {
      letterNumber: letter.letterNumber,
      category: letter.category,
      aiGenerated: letter.aiGenerated,
      aiModel: letter.aiModel,
    },
  });

  return { id: letter.id, letterNumber: letter.letterNumber };
}

export async function updateLetter(
  ctx: AuthContext,
  id: string,
  input: { subject?: string; body?: string; filled?: Record<string, string> },
) {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, status: true },
  });
  if (!letter) throw new NotFoundError("That letter");
  if (letter.status !== "DRAFT") {
    throw new ConflictError(
      "An issued letter cannot be edited. Revoke it and draft a replacement instead.",
    );
  }

  await prisma.letter.update({
    where: { id },
    data: {
      ...(input.subject !== undefined ? { subject: input.subject.trim() } : {}),
      ...(input.body !== undefined
        ? {
            body: input.body,
            variables: {
              placeholders: extractPlaceholders(input.body),
              filled: input.filled ?? {},
            },
          }
        : {}),
    },
  });

  return { id };
}

// ------------------------------------------------------------------ issuing

/**
 * The framework behind a letter, without importing the templates module.
 *
 * `templates.ts` imports `letterValues` from here, so reaching back the other
 * way at module load would be a cycle. A local read of the same two facts is
 * cheaper than restructuring both.
 */
async function frameworkFor(ctx: AuthContext, category: string) {
  const row = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category, active: true },
    select: {
      headerText: true,
      footerText: true,
      showLogo: true,
      // The signatory comes from here now, looked up by category like the
      // header and footer beside it. `issueLetter` used to read it off
      // `letter.template` -- the relation -- which the composer never sets,
      // so it was null for every letter this product has ever issued and the
      // title had to be typed by hand into the fill-in form every time.
      signatoryName: true,
      signatoryTitle: true,
      signatureKey: true,
      showSignature: true,
      showStamp: true,
    },
  });

  // The organisation's signatory, which every category falls back to.
  //
  // Without this a signature uploaded once reached exactly one letter type and
  // the other nine printed a name with nothing under it — which is what "the
  // signature does not appear in letters" was.
  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { signatoryName: true, signatoryTitle: true, signatureKey: true },
  });

  const fallback = LETTER_DEFAULTS[category as keyof typeof LETTER_DEFAULTS];
  return {
    header: row ? (row.headerText ?? "") : (fallback?.header ?? ""),
    footer: row ? (row.footerText ?? "") : (fallback?.footer ?? ""),
    showLogo: row?.showLogo ?? true,
    // Field by field: an organisation whose director signs everything but whose
    // offer letters are signed by HR overrides the name on one category and
    // still uses the same uploaded image.
    signatoryName: row?.signatoryName ?? org?.signatoryName ?? null,
    signatoryTitle: row?.signatoryTitle ?? org?.signatoryTitle ?? null,
    signatureKey: row?.signatureKey ?? org?.signatureKey ?? null,
    showSignature: row?.showSignature ?? true,
    showStamp: row?.showStamp ?? true,
  };
}


/**
 * The same document, before it is a document.
 *
 * There has never been a way to look at a letter without issuing one. The only
 * caller of `renderLetterPdf` was `issueLetter`, which refuses outright when any
 * placeholder is unresolved — so an organisation could not check its own
 * letterhead, its signature or its wording except by sending a real letter to a
 * real employee and reading that.
 *
 * The refusal is not removed, it is moved: `renderTemplate` has always rendered
 * `[Monthly salary]` for a value it does not have and reported a problem beside
 * it, and `canIssue` is the separate decision. Looking is allowed with problems;
 * issuing is not. The page carries a DRAFT watermark so the two can never be
 * confused, and nothing is stored, audited or marked issued.
 */
export async function previewLetterPdf(
  ctx: AuthContext,
  id: string,
): Promise<{ pdf: Buffer; problems: RenderProblem[] }> {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
  });
  if (!letter) throw new NotFoundError("That letter");

  const { pdf, rendered } = await composeLetterPdf(ctx, letter, { draft: true });
  return { pdf, problems: rendered.problems };
}

/**
 * Turns a draft into a document.
 *
 * The placeholders are resolved and the PDF rendered here, once. If anything is
 * still unresolved the issue is refused — a letter that goes out reading
 * "[Monthly salary]" is worse than one that was never sent.
 */
/**
 * The document itself, from a draft row.
 *
 * Lifted out of `issueLetter` so that a preview and the real thing are produced
 * by the same code. They were not, because there was no preview at all: the only
 * caller of `renderLetterPdf` in the product was `issueLetter`, and it refuses
 * outright when a placeholder is unresolved. So the only way to see a letter was
 * to finish it — and the only way to find out that the letterhead was wrong, or
 * that the signature was missing, was to issue one to a real employee.
 *
 * `renderTemplate` has always coped with a missing value: it renders `[Salary]`
 * and reports a problem. It is `canIssue` that blocks, and blocking is right for
 * issuing and wrong for looking.
 */
async function composeLetterPdf(
  ctx: AuthContext,
  letter: {
    id: string;
    category: string;
    subject: string;
    body: string;
    letterNumber: string;
    employeeId: string;
    variables: unknown;
  },
  options: { draft?: boolean } = {},
): Promise<{ pdf: Buffer; rendered: ReturnType<typeof renderTemplate>; today: DateOnly }> {
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const framework = await frameworkFor(ctx, letter.category);

  // The same resolution the compose screen showed, from the framework this
  // function already holds. Sharing it is the point: the preview and the issued
  // PDF disagreeing about who signed is not a difference anybody can see until
  // the letter is out.
  const signatory = await signatoryFrom(ctx, framework);

  const fromRecord = await letterValues(ctx, letter.employeeId, {
    number: letter.letterNumber,
    date: today,
    signatory,
  });
  // Typed values win over the record. They are the answer to placeholders no
  // column can fill, and to the occasional one the record has wrong.
  const filled = (letter.variables as { filled?: Record<string, string> } | null)?.filled ?? {};
  const values = { ...fromRecord, ...filled };
  const rendered = renderTemplate(letter.body, values);
  const organization = await prisma.organization.findUnique({
    // Asserted rather than checked: both callers run `requireOrg` before
    // reaching here, and this helper is not exported.
    where: { id: ctx.organizationId! },
    select: {
      name: true,
      legalName: true,
      email: true,
      phone: true,
      website: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      cin: true,
      gstin: true,
      panNumber: true,
      tan: true,
      pfCode: true,
      esiCode: true,
      stampKey: true,
    },
  });

  /**
   * The header, footer and logo the framework asks for.
   *
   * `renderLetterPdf` has always accepted `logoDataUri` and rendered it, and
   * `issueLetter` never supplied one — so no letter this product has ever
   * issued carried the organisation's logo, despite the code to draw it being
   * right there. The framework's header and footer were in the same position:
   * columns that existed, that nothing wrote and nothing read.
   */
  const header = await documentHeader(ctx.organizationId!, "letter");

  const pdf = await renderLetterPdf({
    organization: {
      name: header?.name ?? organization?.name ?? "",
      address: header?.address ?? null,
      contact: header?.contact ?? null,
      statutory: header?.statutory ?? null,
      // The framework decides whether *this kind* of letter carries a logo; the
      // organisation decides whether it has one.
      logoDataUri: framework.showLogo ? (header?.logoDataUri ?? null) : null,
    },
    letterNumber: letter.letterNumber,
    issuedOn: formatLongDate(today),
    // Sanitised on the way in. An administrator can type anything into the
    // template editor, rupee signs included, and on a build without the
    // embedded font Helvetica draws U+20B9 as a superscript one -- on a
    // document the organisation puts its name to.
    subject: toPdfSafeText(letter.subject),
    headerText: toPdfSafeText(renderTemplate(framework.header, values).text),
    body: toPdfSafeText(rendered.text),
    footerNote: framework.footer
      ? toPdfSafeText(renderTemplate(framework.footer, values).text)
      : undefined,
    signatory: {
      // Read back out of `values`, not from the `signatory` object above.
      // `values` is `fromRecord` with the typed answers laid over it, so a name
      // somebody corrected on the compose screen is the one that prints. Passing
      // the pre-`filled` object meant the body said one name and the block below
      // said another — two different signatories on one letter.
      name: values["signatory.name"] ?? null,
      title: values["signatory.title"] ?? null,
      // `LetterTemplate.signatureKey` has been a column since the schema was
      // written, and `renderLetterPdf` has drawn `signatureDataUri` for just as
      // long. Nothing ever wrote one or read one, so every letter went out
      // with a typed name where a signature belongs.
      // The toggle, honoured at the last moment before it is drawn. Both were
      // unconditional: the signature appeared whenever a row had one and the
      // stamp whenever the organisation had one, with nothing anywhere able to
      // say "not on this letter".
      signatureDataUri: framework.showSignature
        ? await storedImageDataUri(framework.signatureKey)
        : null,
    },
    stampDataUri: framework.showStamp
      ? await storedImageDataUri(organization?.stampKey ?? null)
      : null,
    watermark: options.draft ? "DRAFT" : null,
  });
  return { pdf, rendered, today };
}

export async function issueLetter(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { employee: { select: { id: true, userId: true } }, template: true },
  });
  if (!letter) throw new NotFoundError("That letter");
  if (letter.status === "ISSUED") throw new ConflictError("That letter has already been issued.");
  if (letter.status === "REVOKED") throw new ConflictError("That letter was revoked.");

  const { pdf, rendered, today } = await composeLetterPdf(ctx, letter);

  if (!canIssue(rendered)) {
    throw new ValidationError(
      "This letter still has unresolved placeholders and cannot be issued.",
      { problems: rendered.problems },
    );
  }

  const key = `org/${ctx.organizationId}/letters/${letter.letterNumber.replace(/\//g, "-")}.pdf`;
  await storage().put(key, pdf, "application/pdf", {
    organizationId: ctx.organizationId,
    kind: "letters",
  });

  await prisma.letter.update({
    where: { id },
    data: {
      // The resolved text is stored, not the template: this is now the record
      // of what was actually sent.
      body: rendered.text,
      status: "ISSUED",
      issuedOn: new Date(`${today}T00:00:00.000Z`),
      issuedById: ctx.userId,
      fileKey: key,
    },
  });

  await writeAudit(ctx, {
    action: "letter.issued",
    entityType: "Letter",
    entityId: id,
    before: { status: letter.status },
    after: { status: "ISSUED", letterNumber: letter.letterNumber, sizeBytes: pdf.length },
  });

  if (letter.employee.userId) {
    await notify.toUser(letter.employee.userId, {
      type: "letter.issued",
      title: "A letter has been issued to you",
      body: `${letter.subject} (${letter.letterNumber})`,
      link: "/me/letters",
    });
  }

  return { id, letterNumber: letter.letterNumber, pdfUrl: `/api/files/${key}` };
}

export async function revokeLetter(ctx: AuthContext, id: string, reason?: string) {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, status: true, letterNumber: true },
  });
  if (!letter) throw new NotFoundError("That letter");
  if (letter.status !== "ISSUED") throw new ConflictError("Only an issued letter can be revoked.");

  // The PDF is deliberately kept: a revoked letter still went out, and the
  // record of what it said is the point of revoking rather than deleting.
  await prisma.letter.update({
    where: { id },
    data: { status: "REVOKED", revokedAt: new Date() },
  });

  await writeAudit(ctx, {
    action: "letter.revoked",
    entityType: "Letter",
    entityId: id,
    before: { status: "ISSUED" },
    after: { status: "REVOKED", reason: reason?.trim() || null },
  });

  return { id, status: "REVOKED" as const };
}

export async function deleteDraft(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");

  const letter = await prisma.letter.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, status: true },
  });
  if (!letter) throw new NotFoundError("That letter");
  if (letter.status !== "DRAFT") {
    throw new ConflictError("Only a draft can be deleted. Issued letters are revoked, not removed.");
  }

  await prisma.letter.delete({ where: { id } });
  return { id };
}

// ------------------------------------------------------------------ templates

export async function listTemplates(ctx: AuthContext) {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");

  return prisma.letterTemplate.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    orderBy: { title: "asc" },
    select: {
      id: true,
      title: true,
      category: true,
      bodyTemplate: true,
      signatoryName: true,
      signatoryTitle: true,
      placeholders: true,
    },
  });
}
