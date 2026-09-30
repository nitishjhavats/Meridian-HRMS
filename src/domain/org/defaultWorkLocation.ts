/**
 * Which branch an employee belongs to when nobody chose one.
 *
 * This exists because of a measurement, not a preference. On production, every
 * employee in every organisation had `workLocationId = NULL`. That is not an
 * oversight by one administrator — it is what the product does by default: the
 * employee form offers the field, allows it to be skipped, and nothing fills it
 * in afterwards.
 *
 * The consequence was the whole geofence. `markAttendance` only measures a
 * distance when the employee has an *active* work location assigned; with none,
 * `requireGps: true` merely forces coordinates to be *present* and they are
 * never compared to anything. Two hundred metres and two hundred kilometres
 * were the same answer, for everybody, since the feature shipped.
 *
 * So the fix is not "remind the admin". It is that an employee always has a
 * branch unless somebody deliberately removes it.
 *
 * Pure: the caller supplies the organisation's locations and whatever the form
 * sent, and gets back the id to store.
 */

export interface WorkLocationChoice {
  id: string;
  active: boolean;
  isPrimary: boolean;
  /** Oldest first. Used only to break a tie when no primary is marked. */
  createdAt: Date;
}

/**
 * The branch to store.
 *
 * `chosen` wins whenever it names one of this organisation's locations —
 * including an inactive one, because reassigning somebody to a branch that is
 * being wound down is a decision an administrator is allowed to make and this
 * function is not the place to refuse it.
 *
 * Otherwise: the primary branch, else the oldest active one, else null. Null is
 * still reachable — an organisation with no locations at all, which is how every
 * organisation starts — and callers must keep handling it.
 */
export function resolveWorkLocationId(
  locations: readonly WorkLocationChoice[],
  chosen?: string | null,
): string | null {
  if (chosen) {
    const named = locations.find((l) => l.id === chosen);
    if (named) return named.id;
    // A id that belongs to nobody here is not silently swapped for a default —
    // that would be this function quietly moving somebody to another branch.
    // The caller's own tenant check refuses it.
    return chosen;
  }

  const active = locations.filter((l) => l.active);
  const primary = active.find((l) => l.isPrimary);
  if (primary) return primary.id;

  const oldest = [...active].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
  return oldest?.id ?? null;
}

/**
 * Marking one branch primary means unmarking the others.
 *
 * Returned as two lists rather than performed, so the caller runs both in one
 * transaction and a half-applied change cannot leave an organisation with two
 * primaries — which is exactly the shape of the `OrgPolicyVersion` bug this
 * codebase already has, where publishing a new version never deactivated the
 * old one and Jivonik ended up with two active attendance policies.
 */
export function primarySwitch(
  locations: readonly WorkLocationChoice[],
  next: string,
): { markPrimary: string; clearPrimary: string[] } {
  return {
    markPrimary: next,
    clearPrimary: locations.filter((l) => l.isPrimary && l.id !== next).map((l) => l.id),
  };
}

/**
 * Whether this organisation can enforce a geofence at all.
 *
 * An organisation with no active work location has nothing to measure against,
 * and switching `requireWorkLocation` on for it would refuse every mark. The
 * setup checklist asks this before offering the switch.
 */
export function canEnforceFence(locations: readonly WorkLocationChoice[]): boolean {
  return locations.some((l) => l.active);
}
