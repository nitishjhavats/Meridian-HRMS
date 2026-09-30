import { prisma } from "@/lib/db/prisma";
import { getPayrollPolicy } from "@/services/policy";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { enforce } from "@/lib/ratelimit";
import { complete } from "@/lib/ai/openrouter";
import {
  CATEGORY_LABELS,
  PLACEHOLDERS,
  type LetterCategory,
  extractPlaceholders,
  renderTemplate,
} from "@/domain/letters/template";
import { letterValues } from "@/services/letters";

/**
 * AI letter drafting.
 *
 * The model writes a *template*, not a finished letter — it is told to use
 * `{{placeholders}}` for anything factual rather than inventing names, dates or
 * salary figures. That is the whole design: a language model asked for "an
 * offer letter for Sneha" will happily produce a plausible salary, and a
 * plausible salary on an offer letter is a serious problem. Placeholders are
 * filled from the database at issue time, so the facts come from the record.
 *
 * Nothing is written except a DRAFT. Issuing stays a human action.
 */

const SYSTEM_PROMPT = `You draft HR letters for an Indian company's HR system.

RULES — follow all of them:
1. Write the letter body only. No subject line, no letterhead, no address block,
   no "Sincerely" sign-off block — the system adds all of those.
2. NEVER invent facts. For anything specific to a person or company, emit a
   placeholder in double braces instead. Available placeholders:
{{PLACEHOLDER_LIST}}
3. Use ONLY placeholders from that list. Do not create new ones.
4. Plain prose in paragraphs separated by blank lines. No markdown, no bullet
   characters, no headings.
5. Professional, warm and plain. Indian business English. Avoid legalese unless
   the letter type genuinely requires it.
6. Do not state salary, dates or names literally — always via placeholders.

Return ONLY the letter body text. No commentary, no code fences.`;

export interface DraftLetterInput {
  employeeId: string;
  category: string;
  /** What the person wants the letter to say. */
  prompt: string;
  /** Optional extra context, e.g. "effective 1 October". */
  context?: string;
}

export interface LetterDraft {
  subject: string;
  body: string;
  /** The body with real values substituted, for the preview pane. */
  preview: string;
  problems: { key: string; kind: string; message: string }[];
  placeholders: string[];
  canIssue: boolean;
  model: string;
  tokensUsed: number;
}

export async function draftLetter(ctx: AuthContext, input: DraftLetterInput): Promise<LetterDraft> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.issue", "letters");
  /**
   * `ai.use` was declared, granted to HR and above, and checked by nothing —
   * the AI paths gated on the *module* plus an unrelated permission, so the
   * only way to deny one person AI was to switch it off for everybody. This is
   * the check the permission was written for.
   */
  requirePermission(ctx, "ai.use");
  if (!ctx.modules.has("ai")) {
    throw new ValidationError("AI assistance is switched off for this organisation.");
  }

  // A drafting loop is the expensive kind of mistake; cap it per organisation.
  await enforce("aiRequest", `org:${ctx.organizationId}`);

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  const category = input.category as LetterCategory;
  const categoryLabel = CATEGORY_LABELS[category] ?? input.category;

  const config = await prisma.aiConfig.findUnique({
    where: { organizationId: ctx.organizationId },
    select: { letterSystemPrompt: true },
  });

  const placeholderList = PLACEHOLDERS.map((p) => `   - {{${p.key}}} — ${p.label}: ${p.hint}`).join("\n");
  const system = (config?.letterSystemPrompt?.trim() || SYSTEM_PROMPT).replace(
    "{{PLACEHOLDER_LIST}}",
    placeholderList,
  );

  const result = await complete(ctx.organizationId, {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          `Letter type: ${categoryLabel}`,
          `What it should say: ${input.prompt}`,
          input.context ? `Additional context: ${input.context}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0.4,
  });

  // Models add fences and a "Subject:" line however firmly they are told not to.
  const body = result.content
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/^\s*subject\s*:.*$/im, "")
    .trim();

  if (body.length < 40) {
    throw new ValidationError("The AI returned too little to be a letter. Try rephrasing.");
  }

  const values = await letterValues(ctx, input.employeeId, { number: `${category}/…/…` });
  const rendered = renderTemplate(body, values);

  await writeAudit(ctx, {
    action: "letter.generated",
    entityType: "Letter",
    metadata: {
      via: "ai",
      category: input.category,
      model: result.model,
      tokens: result.promptTokens + result.completionTokens,
      employeeId: input.employeeId,
    },
  });

  return {
    subject: categoryLabel,
    body,
    preview: rendered.text,
    problems: rendered.problems,
    placeholders: extractPlaceholders(body),
    // Unknown placeholders block; a missing *value* is only a warning at draft
    // time, because the reviewer may still be choosing the employee.
    canIssue: rendered.problems.every((p) => p.kind !== "UNKNOWN"),
    model: result.model,
    tokensUsed: result.promptTokens + result.completionTokens,
  };
}

// ------------------------------------------------------- customising a part

const CUSTOMISE_PROMPT = `You edit one part of an HR letter template for an Indian company.

You are given the CURRENT TEXT of one part — the header, the body or the footer —
and an INSTRUCTION describing how to change it. Return the edited text.

RULES — follow all of them:
1. Make the change asked for and nothing else. Preserve wording, tone and
   structure that the instruction did not ask you to touch.
2. NEVER invent a fact. Anything specific to a person or a company must be a
   placeholder in double braces. Available placeholders:
{{PLACEHOLDER_LIST}}
3. Use ONLY placeholders from that list. Do not create new ones. If the
   instruction asks for something no placeholder covers, leave a clearly worded
   blank for a person to fill rather than making it up.
4. Plain prose. Paragraphs separated by blank lines. No markdown, no bullet
   characters, no headings — the PDF renderer draws paragraphs and nothing else.
5. A header is one to three short lines. A footer is a single short line.

Return ONLY the edited text. No commentary, no code fences, no explanation.`;

export type TemplatePart = "header" | "body" | "footer";

export interface CustomiseTemplateInput {
  category: string;
  part: TemplatePart;
  /** What the text says now. */
  current: string;
  /** What the administrator wants changed, in their own words. */
  instruction: string;
}

export interface CustomisedTemplate {
  text: string;
  /** Placeholders the model used that are not in the catalogue, if any. */
  unknownPlaceholders: string[];
  model: string;
  tokensUsed: number;
}

/**
 * Edits one part of a letter framework from a written instruction.
 *
 * Deliberately narrower than `draftLetter`: it is given the current text and
 * asked to change it, rather than asked to write a letter from nothing. That is
 * what makes "put our GST number in the header" a safe request — the model has
 * something to preserve, so the usual failure of a language model handed a blank
 * page (inventing a plausible clause) has much less room.
 *
 * **It saves nothing.** The result lands in the editor, the administrator
 * previews it, and saving is a separate deliberate act. A letter framework is
 * a legal document for everybody it is ever issued to.
 */
export async function customiseTemplate(
  ctx: AuthContext,
  input: CustomiseTemplateInput,
): Promise<CustomisedTemplate> {
  requireOrg(ctx);
  requireWrite(ctx, "letter.template.manage", "letters");
  requirePermission(ctx, "ai.use");
  if (!ctx.modules.has("ai")) {
    throw new ValidationError("AI assistance is switched off for this organisation.");
  }

  const instruction = input.instruction.trim();
  if (instruction.length < 4) {
    throw new ValidationError("Say what you would like changed.");
  }

  await enforce("aiRequest", `org:${ctx.organizationId}`);

  const categoryLabel = CATEGORY_LABELS[input.category as LetterCategory] ?? input.category;
  const placeholderList = PLACEHOLDERS.map((p) => `   - {{${p.key}}} — ${p.label}: ${p.hint}`).join("\n");
  const system = CUSTOMISE_PROMPT.replace("{{PLACEHOLDER_LIST}}", placeholderList);

  /**
   * Who is asking.
   *
   * The instruction was the only thing this ever sent, so "make it warmer" was
   * answered by a model that did not know the organisation's name, what it
   * does, where it is, or whether it runs PF and ESI — and produced text that
   * read like a template because that is all it had. Asking it to rewrite a
   * letter "for us" was a request it had no way to honour.
   *
   * Facts only, and only ones already printed on the letterhead of every letter
   * the organisation issues. Nothing about an employee ever reaches this: the
   * model is writing the *template*, and a template that mentions one person is
   * a bug in every letter after the first.
   */
  const organization = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: {
      name: true,
      legalName: true,
      city: true,
      state: true,
      country: true,
      website: true,
      signatoryName: true,
      signatoryTitle: true,
    },
  });

  const payroll = (await getPayrollPolicy(ctx).catch(() => null))?.policy ?? null;

  const about = [
    `Organisation: ${organization?.legalName || organization?.name || "(unnamed)"}`,
    organization?.name && organization?.legalName && organization.name !== organization.legalName
      ? `Trading as: ${organization.name}`
      : null,
    [organization?.city, organization?.state, organization?.country].filter(Boolean).length > 0
      ? `Based in: ${[organization?.city, organization?.state, organization?.country].filter(Boolean).join(", ")}`
      : null,
    organization?.website ? `Website: ${organization.website}` : null,
    organization?.signatoryName
      ? `Letters are signed by: ${organization.signatoryName}${organization.signatoryTitle ? `, ${organization.signatoryTitle}` : ""}`
      : null,
    payroll
      ? `Statutory: provident fund is ${payroll.statutory.providentFund.enabled ? "deducted" : "not deducted"}; ESI is ${payroll.statutory.esi.enabled ? "deducted" : "not deducted"}. Do not mention a scheme that is not deducted.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await complete(ctx.organizationId, {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          "ABOUT THIS ORGANISATION:",
          about,
          "",
          `Letter type: ${categoryLabel}`,
          `Part: ${input.part}`,
          "CURRENT TEXT:",
          input.current || "(empty)",
          "",
          `INSTRUCTION: ${instruction}`,
        ].join("\n"),
      },
    ],
    // Lower than drafting: this is an edit, and an edit that wanders is worse
    // than one that is dull.
    temperature: 0.2,
  });

  const text = result.content
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!text) throw new ValidationError("The AI returned nothing. Try rephrasing.");

  // Reported rather than rejected: the administrator can see what it reached
  // for and decide, and `saveFramework` refuses an unknown placeholder anyway.
  const unknownPlaceholders = renderTemplate(text, {})
    .problems.filter((p) => p.kind === "UNKNOWN")
    .map((p) => p.key);

  await writeAudit(ctx, {
    action: "letter.generated",
    entityType: "LetterTemplate",
    metadata: {
      via: "ai",
      customised: input.part,
      category: input.category,
      model: result.model,
      tokens: result.promptTokens + result.completionTokens,
    },
  });

  return {
    text,
    unknownPlaceholders,
    model: result.model,
    tokensUsed: result.promptTokens + result.completionTokens,
  };
}
