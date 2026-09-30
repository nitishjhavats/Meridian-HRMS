/**
 * Two-level feature flags.
 *
 *   Level 1 — the Superadmin *grants* which modules an organisation may use.
 *   Level 2 — the organisation's Admin *enables* the ones they actually want.
 *
 * A module is live only when both are true. One resolver feeds navigation, route
 * guards and API handlers so the two levels can never drift apart — a module that
 * disappears from the sidebar also 403s if someone types its URL.
 */

export type ModuleKey =
  | "attendance"
  | "leave"
  | "payroll"
  | "documents"
  | "letters"
  | "announcements"
  | "reports"
  | "exit"
  | "reimbursements"
  | "onboarding"
  | "assets"
  | "performance"
  | "recognition"
  | "chat"
  | "ai";

export interface ModuleDefinition {
  key: ModuleKey;
  name: string;
  description: string;
  /** Core modules cannot be switched off — the product would not make sense. */
  core: boolean;
  /** Granted by default when a new organisation is created. */
  defaultGranted: boolean;
  /**
   * Switched on by default once granted.
   *
   * **Every module ships on now.** Seven of them shipped off -- exit,
   * reimbursements, onboarding, assets, recognition, chat and performance --
   * which meant a new organisation could not see features it was paying for
   * until somebody found the modules screen and guessed which ones existed.
   * Chat was the visible one: the nav entry was written and the icon never
   * appeared beside Announcements, because the module behind it was off.
   *
   * Switching one *off* is a deliberate act now, which is the right way round,
   * and it can be done for the whole organisation, for a designation, or for
   * one person.
   */
  defaultEnabled: boolean;
  /** Other modules this one needs. */
  requires?: ModuleKey[];
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    key: "attendance",
    name: "Attendance",
    description: "GPS and selfie check-in, day statuses, regularisation, overrides.",
    core: true,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "leave",
    name: "Leave",
    description: "Leave types, balances, accrual and approval by reporting line.",
    core: true,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "payroll",
    name: "Payroll & Salary",
    description: "Salary structures, the rule engine, payroll runs, slips and disbursement.",
    core: true,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "documents",
    name: "Document Vault",
    description: "Employee documents with versions and approval-gated deletion.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "letters",
    name: "Letters",
    description: "Templates, AI drafting and PDF issuance of official letters.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "announcements",
    name: "Announcements",
    description: "Company feed with targeting, likes and comments.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "reports",
    name: "Reports",
    description: "Exportable attendance, leave, payroll and payment reports.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "exit",
    name: "Exit & Full-and-Final",
    description: "Resignation, notice tracking, clearance checklist and final settlement.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
    requires: ["payroll"],
  },
  {
    key: "reimbursements",
    name: "Reimbursements",
    description: "Expense claims with bills, approval and payout through payroll.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
    requires: ["payroll"],
  },
  {
    key: "onboarding",
    name: "Onboarding",
    description: "Joining checklists and task assignment for new employees.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "assets",
    name: "Assets",
    description: "Issue and return of laptops, phones and other company property.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "recognition",
    name: "Recognition",
    description:
      "Employee of the Month: the parameters it is decided on, the monthly result, and how many times each person has won.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "chat",
    name: "Employee Chat",
    description:
      "Direct messages between employees. Text only, kept for thirty days, and never deletable.",
    core: false,
    defaultGranted: true,
    // This is the one that shipped off, on the argument that a company-wide
    // chat appearing overnight is not a thing to do to a live tenant. The cost
    // was that the nav entry was written and the icon never appeared beside
    // Announcements, so nobody asked for chat because nobody knew it was
    // there. The comment saying it was still off outlived the change by two
    // commits, which is the other reason it is written out here.
    defaultEnabled: true,
  },
  {
    key: "performance",
    name: "Performance",
    description: "Goals, review cycles and self/manager appraisals.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
  {
    key: "ai",
    name: "AI Assistance",
    description: "OpenRouter-powered letter drafting and payroll rule generation.",
    core: false,
    defaultGranted: true,
    defaultEnabled: true,
  },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function getModule(key: ModuleKey): ModuleDefinition | undefined {
  return MODULE_BY_KEY.get(key);
}

export function isModuleKey(value: string): value is ModuleKey {
  return MODULE_BY_KEY.has(value as ModuleKey);
}

export interface FeatureInputs {
  /** Superadmin grants: `{ [key]: granted }`. Missing = fall back to the default. */
  grants: Record<string, boolean>;
  /** Organisation toggles: `{ [key]: enabled }`. Missing = fall back to the default. */
  settings: Record<string, boolean>;
}

export interface ModuleState {
  key: ModuleKey;
  granted: boolean;
  enabled: boolean;
  /** Granted AND enabled AND every dependency live. */
  live: boolean;
  /** Why it is off, for the settings screen. */
  blockedBy?: "NOT_GRANTED" | "DISABLED" | "MISSING_DEPENDENCY";
  missingDependency?: ModuleKey;
}

/**
 * Resolves every module's state in one pass, honouring dependencies — turning off
 * Payroll also takes Reimbursements and Exit down, and says so.
 */
export function resolveModules(inputs: FeatureInputs): Record<ModuleKey, ModuleState> {
  const first: Record<string, ModuleState> = {};

  for (const def of MODULES) {
    const granted = def.core ? true : (inputs.grants[def.key] ?? def.defaultGranted);
    const enabled = def.core ? true : (inputs.settings[def.key] ?? def.defaultEnabled);
    first[def.key] = {
      key: def.key,
      granted,
      enabled,
      live: granted && enabled,
      ...(!granted ? { blockedBy: "NOT_GRANTED" as const } : !enabled ? { blockedBy: "DISABLED" as const } : {}),
    };
  }

  // Second pass: dependencies.
  for (const def of MODULES) {
    const state = first[def.key];
    if (!state?.live || !def.requires) continue;
    for (const dependency of def.requires) {
      if (!first[dependency]?.live) {
        first[def.key] = {
          ...state,
          live: false,
          blockedBy: "MISSING_DEPENDENCY",
          missingDependency: dependency,
        };
        break;
      }
    }
  }

  return first as Record<ModuleKey, ModuleState>;
}

export function liveModules(inputs: FeatureInputs): Set<ModuleKey> {
  const resolved = resolveModules(inputs);
  return new Set(MODULE_KEYS.filter((k) => resolved[k]?.live));
}

export function isModuleLive(inputs: FeatureInputs, key: ModuleKey): boolean {
  return resolveModules(inputs)[key]?.live ?? false;
}

/** Modules an Admin may toggle: granted, and not core. */
export function toggleableModules(inputs: FeatureInputs): ModuleDefinition[] {
  const resolved = resolveModules(inputs);
  return MODULES.filter((m) => !m.core && resolved[m.key]?.granted);
}

/** Defaults written when a new organisation is created. */
export function defaultGrants(): Record<ModuleKey, boolean> {
  return Object.fromEntries(MODULES.map((m) => [m.key, m.defaultGranted])) as Record<ModuleKey, boolean>;
}

export function defaultSettings(): Record<ModuleKey, boolean> {
  return Object.fromEntries(MODULES.map((m) => [m.key, m.defaultEnabled])) as Record<ModuleKey, boolean>;
}
