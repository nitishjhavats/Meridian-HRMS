import { prisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/uniqueViolation";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { writeAudit } from "@/lib/audit";
import { IMAGE_CONSTRAINTS, ingestUpload, storage } from "@/lib/storage";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  LETTER_CATEGORIES,
  extractPlaceholders,
  renderTemplate,
  type LetterCategory,
  type RenderedLetter,
} from "@/domain/letters/template";
import {
  LETTER_CATEGORY_ORDER,
  categoryLabel,
  defaultFramework,
  type LetterFramework,
} from "@/domain/letters/defaults";
import { isShippedBody } from "@/domain/letters/shipped";
import { letterValues } from "./index";

/**
 * The organisation's letter frameworks.
 *
 * Every category has a built-in default, held in code. A `LetterTemplate` row
 * is an **override** of that default, and *restore to default* deletes it.
 * Nothing is seeded, so the frameworks work in an organisation that was created
 * five minutes ago and a category added to the product later appears for
 * everybody without a data migration.
 *
 * `letter.template.manage` has existed since the permission list was written
 * and gated nothing, because none of this had been built. So had
 * `LetterTemplate.headerHtml`, `footerHtml`, `showLogo`, `signatureKey` and
 * `placeholders` — five columns read by no code at all.
 */

export interface FrameworkView extends LetterFramework {
  category: LetterCategory;
  label: string;
  /** True when this organisation has edited it away from the built-in default. */
  customised: boolean;
  /**
   * True when the saved wording is byte-for-byte a version the product shipped.
   *
   * Which means nobody wrote it: it was copied into the row on the day a
   * signature was uploaded, back when a row could not exist without carrying
   * the text. The editor says so, and offers to put them back on the built-in.
   */
  frozenCopyOfDefault: boolean;
  signatory: {
    name: string | null;
    title: string | null;
    imageUrl: string | null;
    /** True when it came from the organisation rather than this category. */
    inherited: boolean;
  };
  /** Whether the signature and the stamp are placed on this letter. */
  showSignature: boolean;
  showStamp: boolean;
  showLogo: boolean;
  /** Every placeholder the four parts refer to, for the fill-in form. */
  placeholders: string[];
  updatedAt: string | null;
}

function isCategory(value: string): value is LetterCategory {
  return (LETTER_CATEGORIES as readonly string[]).includes(value);
}

function assertCategory(value: string): LetterCategory {
  if (!isCategory(value)) throw new ValidationError(`${value} is not a letter type.`);
  return value;
}

/**
 * The built-in text, with an organisation's overrides laid over it field by
 * field.
 *
 * **Per field, not per row.** A row used to mean "this organisation owns the
 * wording", so `setFrameworkSignature` -- which needs a row to hang an uploaded
 * image on -- copied the built-in text into it and froze that day's version
 * forever. Nulls mean "not overridden", so uploading a signature no longer
 * takes ownership of the words, and improvements to the shipped defaults keep
 * reaching everybody who never rewrote them.
 */
/**
 * The organisation's own signatory, which every template falls back to.
 *
 * Passing it in rather than reading it here keeps `merge` pure and keeps the
 * queries in the two callers that already run them.
 */
export interface OrgSignatory {
  signatoryName: string | null;
  signatoryTitle: string | null;
  signatureKey: string | null;
}

function merge(
  category: LetterCategory,
  row: {
    bodyTemplate: string | null;
    headerText: string | null;
    footerText: string | null;
    title: string | null;
    signatoryName: string | null;
    signatoryTitle: string | null;
    signatureKey: string | null;
    showLogo: boolean;
    showSignature: boolean;
    showStamp: boolean;
    updatedAt: Date;
  } | null,
  org: OrgSignatory = { signatoryName: null, signatoryTitle: null, signatureKey: null },
): FrameworkView {
  const base = defaultFramework(category);
  const framework: LetterFramework = row
    ? {
        subject: row.title ?? base.subject,
        header: row.headerText ?? base.header,
        body: row.bodyTemplate ?? base.body,
        footer: row.footerText ?? base.footer,
      }
    : base;

  return {
    ...framework,
    category,
    label: categoryLabel(category),
    // The *wording* is customised, which is not the same as a row existing: a
    // row carrying only a signature is still on the shipped text.
    customised: row !== null && (row.title !== null || row.bodyTemplate !== null),
    /**
     * Their saved wording is word for word something the product shipped, so
     * they almost certainly never wrote it -- it was copied into a row the day
     * they uploaded a signature, back when a row could not exist without it.
     *
     * Surfaced rather than fixed silently: the words on a letter an
     * organisation issues to its own staff are theirs to change, even when the
     * product is fairly sure how they got there.
     */
    frozenCopyOfDefault: isShippedBody(category, row?.bodyTemplate ?? null),
    signatory: (() => {
      /**
       * The template's own, else the organisation's.
       *
       * Field by field rather than all-or-nothing: an organisation whose
       * managing director signs everything but whose offer letters are signed
       * by HR should be able to override the *name* on one category and still
       * use the same uploaded signature image.
       */
      const key = row?.signatureKey ?? org.signatureKey;
      return {
        name: row?.signatoryName ?? org.signatoryName,
        title: row?.signatoryTitle ?? org.signatoryTitle,
        // A URL rather than the key, because the editor renders it in an <img>
        // and `/api/files` is the only way anything in storage is readable.
        imageUrl: key ? `/api/files/${key}` : null,
        // Whether it came from this category or from the organisation, so the
        // editor can say "using the organisation's" rather than looking empty.
        inherited: row?.signatureKey == null && org.signatureKey != null,
      };
    })(),
    showSignature: row?.showSignature ?? true,
    showStamp: row?.showStamp ?? true,
    showLogo: row?.showLogo ?? true,
    placeholders: [
      ...new Set([
        ...extractPlaceholders(framework.header),
        ...extractPlaceholders(framework.body),
        ...extractPlaceholders(framework.footer),
      ]),
    ],
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Every letter type, default or overridden, in the order they are needed. */
export async function listFrameworks(ctx: AuthContext): Promise<FrameworkView[]> {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");

  const rows = await prisma.letterTemplate.findMany({
    where: { organizationId: ctx.organizationId!, active: true },
    select: {
      category: true,
      title: true,
      bodyTemplate: true,
      headerText: true,
      footerText: true,
      signatoryName: true,
      signatoryTitle: true,
      signatureKey: true,
      showLogo: true,
      showSignature: true,
      showStamp: true,
      updatedAt: true,
    },
  });

  // The organisation's own signatory, which every category falls back to.
  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { signatoryName: true, signatoryTitle: true, signatureKey: true },
  });

  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return LETTER_CATEGORY_ORDER.map((category) =>
    merge(category, byCategory.get(category) ?? null, org ?? undefined),
  );
}

export async function getFramework(
  ctx: AuthContext,
  rawCategory: string,
): Promise<{ current: FrameworkView; builtIn: LetterFramework }> {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");
  const category = assertCategory(rawCategory);

  const row = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category, active: true },
    select: {
      category: true,
      title: true,
      bodyTemplate: true,
      headerText: true,
      footerText: true,
      signatoryName: true,
      signatoryTitle: true,
      signatureKey: true,
      showLogo: true,
      showSignature: true,
      showStamp: true,
      updatedAt: true,
    },
  });

  // The organisation's own signatory, which every category falls back to.
  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { signatoryName: true, signatoryTitle: true, signatureKey: true },
  });

  return { current: merge(category, row, org ?? undefined), builtIn: defaultFramework(category) };
}

export interface SaveFrameworkInput {
  subject: string;
  header: string;
  body: string;
  footer: string;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  showLogo?: boolean;
  showSignature?: boolean;
  showStamp?: boolean;
}

export async function saveFramework(
  ctx: AuthContext,
  rawCategory: string,
  input: SaveFrameworkInput,
): Promise<FrameworkView> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.template.manage", "letters");
  const category = assertCategory(rawCategory);

  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length < 3) throw new ValidationError("Give the letter a subject.");
  if (body.length < 40) throw new ValidationError("That letter is too short to send to anybody.");

  // An unknown placeholder renders as itself and can never be filled, so the
  // letter would be unissuable and the author would not find out until they
  // tried. Catch it here, where they can still fix it.
  const unknown = renderTemplate([input.header, body, input.footer].join("\n"), {}).problems.filter(
    (p) => p.kind === "UNKNOWN",
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((p) => `{{${p.key}}}`)
        .join(", ")}. Use one from the list beside the editor.`,
    );
  }

  const existing = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category },
    select: { id: true, title: true, bodyTemplate: true },
  });

  // The subject is unique per organisation as well as the category -- the
  // schema has `@@unique([organizationId, title])` beside the one on category,
  // and only the category was ever checked. So "Letter of Employment" on the
  // offer letter and again on the appointment letter hit the index, and the
  // second save came back as a 500 with nothing to say about subjects.
  const sameSubject = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, title: subject, NOT: { category } },
    select: { category: true },
  });
  if (sameSubject) {
    throw new ConflictError(
      `${categoryLabel(sameSubject.category as LetterCategory)} already uses the subject "${subject}". Each letter type needs its own.`,
    );
  }

  const data = {
    title: subject,
    category,
    bodyTemplate: body,
    headerText: input.header.trim() || null,
    footerText: input.footer.trim() || null,
    signatoryName: input.signatoryName?.trim() || null,
    signatoryTitle: input.signatoryTitle?.trim() || null,
    showLogo: input.showLogo ?? true,
    showSignature: input.showSignature ?? true,
    showStamp: input.showStamp ?? true,
    // Kept in step with the text rather than left to drift: it is what the
    // fill-in form is built from.
    placeholders: extractPlaceholders([input.header, body, input.footer].join("\n")),
    active: true,
  };

  const write = existing
    ? prisma.letterTemplate.update({ where: { id: existing.id }, data })
    : prisma.letterTemplate.create({
        data: { ...data, organizationId: ctx.organizationId!, createdById: ctx.userId },
      });
  const saved = await write.catch((error: unknown) => {
    // Two saves racing past the check above: the index refuses the second,
    // and it should hear the same sentence rather than a reference number.
    if (isUniqueViolation(error, "title")) {
      throw new ConflictError(
        `Another letter type already uses the subject "${subject}". Each letter type needs its own.`,
      );
    }
    throw error;
  });

  await writeAudit(ctx, {
    action: "letter.template_updated",
    entityType: "LetterTemplate",
    entityId: saved.id,
    before: existing ? { title: existing.title } : undefined,
    after: { category, title: subject },
  });

  return merge(category, {
    ...data,
    headerText: data.headerText,
    footerText: data.footerText,
    // Not in `data`, and deliberately so: saving the text must not disturb the
    // signature image, which is uploaded separately and lives on the same row.
    signatureKey: saved.signatureKey,
    updatedAt: saved.updatedAt,
  });
}

/**
 * The signature that makes an issued letter look signed rather than typed.
 *
 * `LetterTemplate.signatureKey` and the `signatures` storage kind have both
 * existed since the first migration, and `renderLetterPdf` has always drawn a
 * `signatureDataUri` -- so the read side was complete and every issued letter
 * still resolved it to null, because nothing had ever written the column.
 *
 * Uploading against a category still on its built-in default has to CREATE the
 * override row first: the image lives on the row, and there is no row until an
 * organisation has changed something. The row it creates carries the built-in
 * text verbatim, so adding a signature does not quietly become an edit of the
 * wording -- but the category will read as "customised" from then on, which is
 * true, because it now holds something this organisation supplied.
 *
 * The old file is deleted after the new one is stored, never before, matching
 * `setOrganizationLogo`: a failed upload should leave the previous signature in
 * place rather than none at all.
 */
const SIGNATURE_CONSTRAINTS = {
  ...IMAGE_CONSTRAINTS,
  // A scanned signature is a small transparent PNG. The low cap turns an
  // accidentally uploaded photograph into a clear refusal instead of a
  // 600 px re-encode of somebody's face.
  maxBytes: 1024 * 1024,
};

export async function setFrameworkSignature(
  ctx: AuthContext,
  rawCategory: string,
  file: { data: Buffer; fileName: string; mimeType: string },
): Promise<FrameworkView> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.template.manage", "letters");
  const category = assertCategory(rawCategory);

  const existing = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category },
    select: { id: true, signatureKey: true },
  });
  let created: { id: string } | null = null;

  const stored = await ingestUpload(file, {
    organizationId: ctx.organizationId!,
    kind: "signatures",
    constraints: SIGNATURE_CONSTRAINTS,
  });

  if (existing) {
    await prisma.letterTemplate.update({
      where: { id: existing.id },
      data: { signatureKey: stored.key },
    });
    if (existing.signatureKey && existing.signatureKey !== stored.key) {
      await storage().delete(existing.signatureKey);
    }
  } else {
    /**
     * A row that carries the image and nothing else.
     *
     * This used to copy the built-in text in verbatim, because both text
     * columns were NOT NULL -- so uploading a signature silently froze that
     * day's wording, and every later improvement to the shipped letters stopped
     * dead at organisations that had done nothing but scan in a signature.
     * They are nullable now, and `merge` falls back field by field.
     */
    created = await prisma.letterTemplate.create({
      data: {
        organizationId: ctx.organizationId!,
        createdById: ctx.userId,
        category,
        signatureKey: stored.key,
        active: true,
      },
    });
  }

  await writeAudit(ctx, {
    action: "letter.template_updated",
    entityType: "LetterTemplate",
    entityId: existing?.id ?? created?.id ?? category,
    after: { category, signature: existing?.signatureKey ? "replaced" : "added" },
  });

  return getFrameworkView(ctx, category);
}

export async function clearFrameworkSignature(
  ctx: AuthContext,
  rawCategory: string,
): Promise<FrameworkView> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.template.manage", "letters");
  const category = assertCategory(rawCategory);

  const existing = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category },
    select: { id: true, signatureKey: true },
  });

  // No row, or a row with no signature, is already the state being asked for.
  if (existing?.signatureKey) {
    await prisma.letterTemplate.update({
      where: { id: existing.id },
      data: { signatureKey: null },
    });
    await storage().delete(existing.signatureKey);
    await writeAudit(ctx, {
      action: "letter.template_updated",
      entityType: "LetterTemplate",
      entityId: existing.id,
      after: { category, signature: "removed" },
    });
  }

  return getFrameworkView(ctx, category);
}

/** The single row read, shared by both signature writes above. */
async function getFrameworkView(
  ctx: AuthContext,
  category: LetterCategory,
): Promise<FrameworkView> {
  const row = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category },
    select: {
      title: true,
      bodyTemplate: true,
      headerText: true,
      footerText: true,
      signatoryName: true,
      signatoryTitle: true,
      signatureKey: true,
      showLogo: true,
      showSignature: true,
      showStamp: true,
      updatedAt: true,
    },
  });
  return merge(category, row);
}

/**
 * Back to the built-in.
 *
 * Deleting the row rather than rewriting it with the default's text, so the
 * framework tracks the product from then on: if the default wording is improved
 * in a later release, an organisation that restored gets the improvement.
 */
export async function restoreFramework(
  ctx: AuthContext,
  rawCategory: string,
): Promise<FrameworkView> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.template.manage", "letters");
  const category = assertCategory(rawCategory);

  const existing = await prisma.letterTemplate.findFirst({
    where: { organizationId: ctx.organizationId!, category },
    select: { id: true, signatureKey: true },
  });

  if (existing) {
    /**
     * Restore the *words*, and keep the signature.
     *
     * This deleted the row and the uploaded image with it, which is what
     * "restore to default" had to mean while a row was all-or-nothing. Now that
     * the text is nullable, somebody putting the shipped wording back should
     * not also lose the signature they scanned in: those are two separate
     * decisions and only one of them was asked for.
     *
     * A row with nothing left on it is still deleted, so the case without a
     * signature behaves exactly as it did.
     */
    if (existing.signatureKey) {
      await prisma.letterTemplate.update({
        where: { id: existing.id },
        data: {
          title: null,
          bodyTemplate: null,
          headerText: null,
          footerText: null,
          placeholders: [],
        },
      });
    } else {
      // Letters already issued keep `templateId`, and it is nullable with
      // `SetNull`, so history survives this.
      await prisma.letterTemplate.delete({ where: { id: existing.id } });
    }

    await writeAudit(ctx, {
      action: "letter.template_restored",
      entityType: "LetterTemplate",
      entityId: existing.id,
      after: { category, restoredToDefault: true, keptSignature: Boolean(existing.signatureKey) },
    });
  }

  return getFrameworkView(ctx, category);
}

/**
 * What the framework looks like filled in.
 *
 * With an employee, real values. Without one, the placeholder labels — so a
 * framework can be written and read before anybody has been hired.
 */
export async function previewFramework(
  ctx: AuthContext,
  rawCategory: string,
  options: { employeeId?: string; overrides?: Record<string, string> } = {},
): Promise<{
  subject: string;
  header: RenderedLetter;
  body: RenderedLetter;
  footer: RenderedLetter;
  values: Record<string, string | null | undefined>;
}> {
  requireOrg(ctx);
  requirePermission(ctx, "letter.issue");
  const category = assertCategory(rawCategory);
  const { current } = await getFramework(ctx, category);

  const base = options.employeeId
    ? await letterValues(ctx, options.employeeId, {
        number: `${category}/PREVIEW`,
        signatory: current.signatory,
      })
    : {};
  const values = { ...base, ...(options.overrides ?? {}) };

  return {
    subject: renderTemplate(current.subject, values).text,
    header: renderTemplate(current.header, values),
    body: renderTemplate(current.body, values),
    footer: renderTemplate(current.footer, values),
    values,
  };
}
