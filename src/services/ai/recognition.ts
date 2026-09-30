import { z } from "zod";
import type { RecognitionDirection, RecognitionSource, RecognitionUnit } from "@prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { enforce } from "@/lib/ratelimit";
import { complete, extractJson } from "@/lib/ai/openrouter";
import { monthLabel } from "@/domain/date";
import { MAX_PARAMETERS, REQUIRED_WEIGHT_TOTAL, SUGGESTED_PARAMETERS } from "@/domain/recognition/scoring";
import { SOURCE_UNIT, formatRecognitionValue, type RecognitionSourceKey } from "@/domain/recognition/units";
import {
  type Period,
  type WeightedPlace,
  compareWeightings,
  defaultPeriod,
  getRecognitionSetup,
  previewCycle,
} from "@/services/recognition";

/**
 * AI for Employee of the Month.
 *
 * The model is used in exactly three places, and the winner is not one of them.
 * It suggests what an organisation might measure, it says out loud what a
 * particular split of the weights will actually reward, and — once the arithmetic
 * has produced a winner — it writes the citation from the figures.
 *
 * That boundary is the whole point. A model asked to *choose* produces an
 * outcome nobody can reproduce, nobody can appeal, and nobody can be told the
 * reason for. Everything here is a proposal: it is parsed against a schema,
 * checked against the same rules the save path enforces, and where there is real
 * data it is run through the real scoring engine so an administrator sees who
 * would actually win before anything is applied. Nothing in this file writes a
 * parameter, a weight or an award.
 */

/* ---------------------------------------------------------------- shared */

function requireAi(ctx: AuthContext): void {
  requireOrg(ctx);
  requireWrite(ctx, "recognition.manage", "recognition");
  if (!ctx.modules.has("ai")) {
    throw new ValidationError("AI assistance is switched off for this organisation.");
  }
}

const UNITS = ["RUPEES", "COUNT", "PERCENT", "HOURS", "POINTS"] as const;
const DIRECTIONS = ["HIGHER_IS_BETTER", "LOWER_IS_BETTER"] as const;
const SOURCES = ["MANUAL", "PRESENT_DAYS", "PUNCTUALITY", "OVERTIME_HOURS", "GOALS_COMPLETED"] as const;

/* ------------------------------------------------- 1. suggesting parameters */

const SUGGEST_PARAMETERS_PROMPT = `You help an Indian company decide what to measure for an "Employee of the Month" award.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "parameters": [
    {
      "name": "Short name, 2-5 words, in the organisation's own language",
      "unit": "RUPEES" | "COUNT" | "PERCENT" | "HOURS" | "POINTS",
      "direction": "HIGHER_IS_BETTER" | "LOWER_IS_BETTER",
      "source": "MANUAL" | "PRESENT_DAYS" | "PUNCTUALITY" | "OVERTIME_HOURS" | "GOALS_COMPLETED",
      "weight": 40,
      "encourages": "One sentence: what measuring this will make people actually do."
    }
  ],
  "note": "One or two sentences on the set as a whole, and what it does not capture."
}

Rules you must follow:
- Suggest ${SUGGESTED_PARAMETERS} parameters. Never more than ${MAX_PARAMETERS}.
- The weights must be whole numbers adding up to exactly ${REQUIRED_WEIGHT_TOTAL}.
- Use LOWER_IS_BETTER for anything where less is better: shrinkage, wastage, escalations, complaints, rework, defects.
- "source" says where the figure comes from. Use MANUAL for anything the app cannot count, and one of the others ONLY when it is exactly that measure:
    PRESENT_DAYS — days present, counted from attendance
    PUNCTUALITY — percentage of days with no late arrival
    OVERTIME_HOURS — overtime hours worked
    GOALS_COMPLETED — goals marked achieved
  Never use the same non-MANUAL source twice.
- For a non-MANUAL source the unit is fixed: PRESENT_DAYS and GOALS_COMPLETED are COUNT, PUNCTUALITY is PERCENT, OVERTIME_HOURS is HOURS.
- "encourages" must be honest about the behaviour it drives, including where that behaviour is unwanted. If a parameter would push people to hoard work or refuse help, say so.
- Prefer things the organisation already counts. A parameter nobody has figures for scores everybody zero.
- Indian business English. No jargon.`;

const parameterSchema = z.object({
  name: z.string().trim().min(2).max(60),
  unit: z.enum(UNITS),
  direction: z.enum(DIRECTIONS),
  source: z.enum(SOURCES),
  weight: z.number().int().min(0).max(100),
  encourages: z.string().trim().min(10).max(400),
});

const suggestParametersSchema = z.object({
  parameters: z.array(parameterSchema).min(1).max(8),
  note: z.string().trim().max(600).optional().default(""),
});

export interface SuggestedParameter {
  name: string;
  unit: RecognitionUnit;
  direction: RecognitionDirection;
  source: RecognitionSource;
  weight: number;
  /** One sentence on what measuring this will make people do. */
  encourages: string;
}

export interface ParameterSuggestion {
  parameters: SuggestedParameter[];
  note: string;
  /** What would stop this being saved as it stands. Reported, never silently fixed. */
  problems: string[];
  /** True when the save path would accept this set unchanged. */
  applicable: boolean;
  model: string;
  tokensUsed: number;
}

/**
 * Turns "we are a retail chain of forty people" into a starting set of
 * parameters.
 *
 * Saves nothing. The proposal lands in the settings form, where an administrator
 * edits it and presses Save like any other change — and the save path applies
 * the same rules again, because a proposal is not a permission.
 */
export async function suggestParameters(
  ctx: AuthContext,
  input: { description: string },
): Promise<ParameterSuggestion> {
  requireAi(ctx);

  const description = input.description.trim();
  if (description.length < 15) {
    throw new ValidationError(
      "Describe what your organisation does and what a good month looks like, in a sentence or two.",
    );
  }

  await enforce("aiRequest", `org:${ctx.organizationId}`);

  const setup = await getRecognitionSetup(ctx);
  const existing = setup.parameters.filter((p) => p.active);

  const completion = await complete(ctx.organizationId!, {
    json: true,
    messages: [
      { role: "system", content: SUGGEST_PARAMETERS_PROMPT },
      {
        role: "user",
        content: [
          `Organisation: ${ctx.organization?.name ?? "an Indian company"}`,
          `Headcount: about ${ctx.organization?.activeEmployees ?? "unknown"}`,
          existing.length > 0
            ? `They currently measure: ${existing.map((p) => `${p.name} (${p.weight})`).join(", ")}`
            : "They do not measure anything yet.",
          "",
          `In their own words: ${description}`,
        ].join("\n"),
      },
    ],
    temperature: 0.4,
  });

  const parsed = suggestParametersSchema.safeParse(extractJson(completion.content));
  if (!parsed.success) {
    // Discarded rather than repaired, exactly as the payroll rule generator
    // does: a half-understood proposal patched into something plausible is
    // worse than none.
    throw new ValidationError("The AI returned something that is not a set of parameters.", {
      issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const parameters: SuggestedParameter[] = parsed.data.parameters.slice(0, MAX_PARAMETERS).map((p) => ({
    name: p.name,
    // The source decides the unit for anything counted from real data, whatever
    // the model said.
    unit: (SOURCE_UNIT[p.source as RecognitionSourceKey] ?? p.unit) as RecognitionUnit,
    direction: p.direction as RecognitionDirection,
    source: p.source as RecognitionSource,
    weight: p.weight,
    encourages: p.encourages,
  }));

  const problems = validateSet(parameters);
  const dropped = parsed.data.parameters.length - parameters.length;
  if (dropped > 0) {
    // Said out loud rather than trimmed quietly: the weights on the ones that
    // remain will no longer add up, and that is why.
    problems.unshift(
      `The AI suggested ${parsed.data.parameters.length} measures; only the first ${MAX_PARAMETERS} are shown.`,
    );
  }

  await writeAudit(ctx, {
    action: "ai.recognition_suggested",
    entityType: "RecognitionParameter",
    metadata: {
      kind: "parameters",
      prompt: description.slice(0, 500),
      suggested: parameters.map((p) => p.name),
      model: completion.model,
      tokens: completion.promptTokens + completion.completionTokens,
    },
  });

  return {
    parameters,
    note: parsed.data.note,
    problems,
    applicable: problems.length === 0,
    model: completion.model,
    tokensUsed: completion.promptTokens + completion.completionTokens,
  };
}

/** The same rules the save path enforces, reported instead of thrown. */
function validateSet(parameters: SuggestedParameter[]): string[] {
  const problems: string[] = [];

  const total = parameters.reduce((sum, p) => sum + p.weight, 0);
  if (total !== REQUIRED_WEIGHT_TOTAL) {
    problems.push(`The weights add up to ${total}, not ${REQUIRED_WEIGHT_TOTAL}. Adjust them before saving.`);
  }
  const names = new Set<string>();
  for (const p of parameters) {
    const key = p.name.toLowerCase();
    if (names.has(key)) problems.push(`"${p.name}" appears twice.`);
    names.add(key);
  }

  const sources = new Set<string>();
  for (const p of parameters) {
    if (p.source === "MANUAL") continue;
    if (sources.has(p.source)) problems.push("Two parameters would be counted from the same source.");
    sources.add(p.source);
  }

  return problems;
}

/* ----------------------------------------------------- 2. suggesting weights */

const SUGGEST_WEIGHTS_PROMPT = `You advise an Indian company on how to weight the parameters of its "Employee of the Month" award.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "weights": [{ "parameterId": "the id you were given", "weight": 40 }],
  "rewards": ["One sentence per point: the kind of person this split will pick."],
  "cost": "One sentence: who this split will NOT pick, said plainly."
}

Rules you must follow:
- Give a weight for EVERY parameter you were given, and no others. Use the ids exactly as supplied.
- Weights are whole numbers adding up to exactly ${REQUIRED_WEIGHT_TOTAL}.
- "rewards" is two or three sentences, each naming the behaviour the split encourages.
- "cost" must be blunt. If most of the weight sits on one number, say who loses: "80% on sales means the person who covered three shifts nobody wanted will not win."
- Do not name any individual. You have not been given people, and you are not choosing one.
- Indian business English.`;

const suggestWeightsSchema = z.object({
  weights: z.array(z.object({ parameterId: z.string().min(1), weight: z.number().int().min(0).max(100) })).min(1),
  rewards: z.array(z.string().trim().min(5).max(300)).min(1).max(6),
  cost: z.string().trim().min(5).max(400),
});

export interface WeightSuggestion {
  weights: { parameterId: string; name: string; from: number; to: number }[];
  /** What the split encourages, in the model's words. */
  rewards: string[];
  /** Who it will not pick. */
  cost: string;
  problems: string[];
  applicable: boolean;
  /**
   * The real engine, run over a real month, under the current weights and the
   * proposed ones. Empty when there is no month with enough data to run.
   */
  evidence: {
    period: Period;
    current: WeightedPlace[];
    proposed: WeightedPlace[];
    /** True when the two splits pick a different winner. */
    changesTheWinner: boolean;
  } | null;
  model: string;
  tokensUsed: number;
}

/**
 * Proposes a split of the weights, and shows what it would actually do.
 *
 * The model's sentences about what a split rewards are worth something, but not
 * as much as the ranking underneath them: `rankUnderWeights` runs the real
 * scoring engine over a real month twice, so an administrator can see whether
 * the proposed weights change who wins before agreeing to them.
 */
export async function suggestWeights(
  ctx: AuthContext,
  input: { emphasis: string; year?: number; month?: number },
): Promise<WeightSuggestion> {
  requireAi(ctx);

  const emphasis = input.emphasis.trim();
  if (emphasis.length < 5) {
    throw new ValidationError("Say what you would like the award to reward.");
  }

  const setup = await getRecognitionSetup(ctx);
  const active = setup.parameters.filter((p) => p.active);
  if (active.length === 0) {
    throw new ValidationError("Add some parameters first — there is nothing to weight yet.");
  }

  await enforce("aiRequest", `org:${ctx.organizationId}`);

  const completion = await complete(ctx.organizationId!, {
    json: true,
    messages: [
      { role: "system", content: SUGGEST_WEIGHTS_PROMPT },
      {
        role: "user",
        content: [
          "Parameters:",
          ...active.map(
            (p) =>
              `- id ${p.id} — ${p.name} (${p.unit.toLowerCase()}, ${
                p.direction === "LOWER_IS_BETTER" ? "lower is better" : "higher is better"
              }, currently weighted ${p.weight})`,
          ),
          "",
          `What the organisation wants the award to reward: ${emphasis}`,
        ].join("\n"),
      },
    ],
    temperature: 0.3,
  });

  const parsed = suggestWeightsSchema.safeParse(extractJson(completion.content));
  if (!parsed.success) {
    throw new ValidationError("The AI returned something that is not a set of weights.", {
      issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const byId = new Map(active.map((p) => [p.id, p]));
  const proposed = new Map<string, number>();
  const problems: string[] = [];

  for (const entry of parsed.data.weights) {
    // An id that is not one of this organisation's own is dropped, not trusted.
    if (!byId.has(entry.parameterId)) {
      problems.push("The AI referred to a parameter that does not exist, and it was ignored.");
      continue;
    }
    proposed.set(entry.parameterId, entry.weight);
  }

  const missing = active.filter((p) => !proposed.has(p.id));
  if (missing.length > 0) {
    problems.push(`No weight was suggested for ${missing.map((p) => p.name).join(", ")}.`);
  }

  const total = [...proposed.values()].reduce((sum, w) => sum + w, 0);
  if (missing.length === 0 && total !== REQUIRED_WEIGHT_TOTAL) {
    problems.push(`The suggested weights add up to ${total}, not ${REQUIRED_WEIGHT_TOTAL}.`);
  }

  const weights = active.map((p) => ({
    parameterId: p.id,
    name: p.name,
    from: p.weight,
    to: proposed.get(p.id) ?? p.weight,
  }));

  const evidence = await weighEvidence(ctx, weights, input);

  await writeAudit(ctx, {
    action: "ai.recognition_suggested",
    entityType: "RecognitionParameter",
    metadata: {
      kind: "weights",
      prompt: emphasis.slice(0, 500),
      proposed: weights.map((w) => `${w.name}: ${w.from} → ${w.to}`),
      changesTheWinner: evidence?.changesTheWinner ?? null,
      model: completion.model,
      tokens: completion.promptTokens + completion.completionTokens,
    },
  });

  return {
    weights,
    rewards: parsed.data.rewards,
    cost: parsed.data.cost,
    problems,
    applicable: problems.length === 0,
    evidence,
    model: completion.model,
    tokensUsed: completion.promptTokens + completion.completionTokens,
  };
}

/**
 * Runs the month twice.
 *
 * A month with nobody eligible, or one that has never been scored, proves
 * nothing — so it returns null rather than an empty table dressed up as
 * evidence.
 */
async function weighEvidence(
  ctx: AuthContext,
  weights: { parameterId: string; from: number; to: number }[],
  input: { year?: number; month?: number },
): Promise<WeightSuggestion["evidence"]> {
  const period: Period =
    input.year != null && input.month != null
      ? { year: input.year, month: input.month, label: monthLabel(input.year, input.month) }
      : defaultPeriod(ctx);

  try {
    const { current, proposed } = await compareWeightings(
      ctx,
      period.year,
      period.month,
      Object.fromEntries(weights.map((w) => [w.parameterId, w.from])),
      Object.fromEntries(weights.map((w) => [w.parameterId, w.to])),
    );

    if (current.length === 0 || proposed.length === 0) return null;

    return {
      period,
      current,
      proposed,
      changesTheWinner: current[0]?.employeeId !== proposed[0]?.employeeId,
    };
  } catch {
    // Evidence is a bonus, not the answer. An organisation with no attendance
    // history still gets the suggestion and the sentences that go with it.
    return null;
  }
}

/* ------------------------------------------------------- 3. the citation */

const CITATION_PROMPT = `You write the citation for an Indian company's "Employee of the Month" award.

You are given the winner's name and the actual figures the award was calculated from. The winner has ALREADY been decided by arithmetic. You are not choosing anybody.

RULES — follow all of them:
1. Two or three sentences. Warm, specific, and short enough to read out.
2. Use ONLY the figures you are given. Invent nothing — no projects, no anecdotes, no colleagues, no quotes, no job titles you were not told.
3. Quote the figures as they are written, in the same units.
4. Do not mention scores out of 100, weights, normalisation or rankings. The arithmetic is published beside this; the citation is for the people reading it.
5. Do not compare the winner to anybody else by name.
6. Indian business English, plain and warm. No superlatives you cannot support.

Return ONLY the citation text. No heading, no quotation marks, no commentary.`;

export interface Citation {
  citation: string;
  /** The figures it was written from, so the two can be checked against each other. */
  basedOn: { employeeId: string; name: string; figures: string[] };
  model: string;
  tokensUsed: number;
}

/**
 * Writes the citation, after the arithmetic has picked the winner.
 *
 * It is handed the computed result and the real figures. It cannot choose, it
 * cannot reorder, and it is told in as many words to invent nothing — because a
 * citation that credits somebody with a project they did not run is worse than
 * no citation at all.
 */
export async function writeCitation(
  ctx: AuthContext,
  input: { year: number; month: number; employeeId?: string },
): Promise<Citation> {
  requireAi(ctx);
  await enforce("aiRequest", `org:${ctx.organizationId}`);

  const preview = await previewCycle(ctx, input.year, input.month);
  const winner = input.employeeId
    ? preview.ranked.find((r) => r.employeeId === input.employeeId)
    : preview.ranked[0];

  if (!winner) {
    throw new ValidationError("There is no winner to write about for that month yet.");
  }

  const currency = ctx.organization?.currency ?? "INR";
  const figures = winner.workings
    .filter((w) => !w.missing)
    .map(
      (w) =>
        `${w.parameterName}: ${formatRecognitionValue(w.raw, w.unit, currency)}${
          w.direction === "LOWER_IS_BETTER" ? " (lower is better)" : ""
        }`,
    );

  const completion = await complete(ctx.organizationId!, {
    messages: [
      { role: "system", content: CITATION_PROMPT },
      {
        role: "user",
        content: [
          `Month: ${preview.period.label}`,
          `Winner: ${winner.name}`,
          winner.designation ? `Role: ${winner.designation}` : null,
          winner.department ? `Team: ${winner.department}` : null,
          winner.awardsWon > 0 ? `They have won this award ${winner.awardsWon} time(s) before.` : null,
          "",
          "Their figures for the month:",
          ...figures.map((f) => `- ${f}`),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0.5,
  });

  const citation = completion.content
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();

  if (citation.length < 30) {
    throw new ValidationError("The AI returned too little to be a citation. Try again.");
  }

  await writeAudit(ctx, {
    action: "ai.recognition_suggested",
    entityType: "RecognitionCycle",
    metadata: {
      kind: "citation",
      period: preview.period.label,
      employeeId: winner.employeeId,
      model: completion.model,
      tokens: completion.promptTokens + completion.completionTokens,
    },
  });

  return {
    citation,
    basedOn: { employeeId: winner.employeeId, name: winner.name, figures },
    model: completion.model,
    tokensUsed: completion.promptTokens + completion.completionTokens,
  };
}
