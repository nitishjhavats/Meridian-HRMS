/**
 * Known OpenRouter models.
 *
 * This is a convenience list, not a whitelist — the model field stays free text
 * because ids appear and disappear faster than any list here can be kept
 * accurate. What it buys is that the common choices are one click away and
 * spelled correctly: an id typed from memory is the most common reason a first
 * AI request fails.
 */

export interface AiModelOption {
  id: string;
  label: string;
  /** What it is good for, in the words of somebody choosing rather than benchmarking. */
  note: string;
  free: boolean;
}

export const AI_MODELS: readonly AiModelOption[] = [
  {
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    note: "Fast and cheap. The default, and a good fit for payroll rules and letters.",
    free: false,
  },
  {
    id: "minimax/minimax-m3:free",
    label: "MiniMax M3 (free)",
    note: "No cost, but rate-limited and slower. Useful for trying things out.",
    free: true,
  },
];

/** The id used when nothing has been configured anywhere. */
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export function findModel(id: string): AiModelOption | undefined {
  return AI_MODELS.find((m) => m.id === id);
}
