import type { ModuleKey } from "@/lib/features";

/**
 * Three layers deciding whether one person can see one module.
 *
 * The organisation says what the company does. A designation narrows it to what
 * a job does. A person is the exception neither describes — and every
 * organisation has one, which is why both of the lower layers exist rather than
 * just the cheaper one.
 *
 * **The nearest answer wins**: person, then designation, then organisation.
 * Absent means "ask the layer above", and there is deliberately no third state
 * meaning "same as above" — a row that only repeats its parent is a row
 * somebody has to keep in step by hand, and will not.
 *
 * **A layer can only take away, never add.** Nothing here can switch on a
 * module the platform has not granted or the organisation has switched off:
 * `resolveModules` decides that first and this narrows what is left. Otherwise
 * an admin could hand one person a module the company is not paying for.
 */

export type ModuleOverrides = Partial<Record<ModuleKey, boolean>>;

export interface ModuleScopeInput {
  /** What the organisation already resolved to — grants and settings applied. */
  organisation: ReadonlySet<ModuleKey>;
  /** This person's designation, if they have one. */
  designation?: ModuleOverrides;
  /** This person. */
  user?: ModuleOverrides;
}

export function scopedModules(input: ModuleScopeInput): Set<ModuleKey> {
  const out = new Set<ModuleKey>();

  for (const key of input.organisation) {
    // Only the *off* half of an override is honoured, for the reason above: the
    // organisation's answer is a ceiling, and these two can lower it.
    const person = input.user?.[key];
    if (person === false) continue;
    if (person === true) {
      out.add(key);
      continue;
    }

    if (input.designation?.[key] === false) continue;
    out.add(key);
  }

  return out;
}

/**
 * Turns rows into the lookup `scopedModules` wants.
 *
 * A row for a module the organisation does not have is dropped rather than
 * carried: it cannot change any answer, and keeping it would make the debug
 * output of this function suggest otherwise.
 */
export function overridesFrom(
  rows: readonly { moduleKey: string; enabled: boolean }[],
  known: ReadonlySet<string>,
): ModuleOverrides {
  const out: ModuleOverrides = {};
  for (const row of rows) {
    if (!known.has(row.moduleKey)) continue;
    out[row.moduleKey as ModuleKey] = row.enabled;
  }
  return out;
}
