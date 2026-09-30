/**
 * Who an announcement is for.
 *
 * Targeting is stored as a small JSON document rather than join tables, because
 * an audience is a description ("everyone in Engineering") rather than a
 * membership list — resolving it at read time means a person who joins the
 * department tomorrow sees it, and someone who leaves stops seeing it.
 */

export type AudienceScope = "ALL" | "DEPARTMENT" | "ROLE" | "LOCATION" | "EMPLOYEES";

export interface Audience {
  scope: AudienceScope;
  departmentIds?: string[];
  roles?: string[];
  workLocationIds?: string[];
  employeeIds?: string[];
}

export const EVERYONE: Audience = { scope: "ALL" };

/** What the reader is, for matching against an audience. */
export interface Viewer {
  role: string;
  employeeId: string | null;
  departmentId: string | null;
  workLocationId: string | null;
}

export function parseAudience(value: unknown): Audience {
  if (!value || typeof value !== "object") return EVERYONE;
  const raw = value as Record<string, unknown>;
  const scope = raw.scope;

  if (
    scope !== "ALL" &&
    scope !== "DEPARTMENT" &&
    scope !== "ROLE" &&
    scope !== "LOCATION" &&
    scope !== "EMPLOYEES"
  ) {
    // An unrecognised audience shows to everyone rather than to nobody: a
    // silently invisible announcement is the worse failure.
    return EVERYONE;
  }

  return {
    scope,
    departmentIds: toStringArray(raw.departmentIds),
    roles: toStringArray(raw.roles),
    workLocationIds: toStringArray(raw.workLocationIds),
    employeeIds: toStringArray(raw.employeeIds),
  };
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > 0 ? items : undefined;
}

export function isVisibleTo(audience: Audience, viewer: Viewer): boolean {
  switch (audience.scope) {
    case "ALL":
      return true;
    case "DEPARTMENT":
      return Boolean(viewer.departmentId && audience.departmentIds?.includes(viewer.departmentId));
    case "ROLE":
      return Boolean(audience.roles?.includes(viewer.role));
    case "LOCATION":
      return Boolean(
        viewer.workLocationId && audience.workLocationIds?.includes(viewer.workLocationId),
      );
    case "EMPLOYEES":
      return Boolean(viewer.employeeId && audience.employeeIds?.includes(viewer.employeeId));
  }
}

/** A sentence for the author, so a narrow audience is obvious before publishing. */
export function describeAudience(
  audience: Audience,
  names: {
    departments?: Map<string, string>;
    locations?: Map<string, string>;
    employees?: Map<string, string>;
  } = {},
): string {
  const list = (ids: string[] | undefined, lookup: Map<string, string> | undefined, noun: string) => {
    if (!ids || ids.length === 0) return `selected ${noun}`;
    const labels = ids.map((id) => lookup?.get(id) ?? id);
    if (labels.length <= 3) return labels.join(", ");
    return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
  };

  switch (audience.scope) {
    case "ALL":
      return "Everyone in the organisation";
    case "DEPARTMENT":
      return `${list(audience.departmentIds, names.departments, "departments")}`;
    case "ROLE":
      return `Everyone who is ${list(audience.roles, undefined, "roles")}`;
    case "LOCATION":
      return `${list(audience.workLocationIds, names.locations, "locations")}`;
    case "EMPLOYEES":
      return list(audience.employeeIds, names.employees, "people");
  }
}

/** Whether an announcement should be on the feed at this moment. */
export function isLive(
  announcement: { published: boolean; publishAt: Date; expiresAt: Date | null },
  now = new Date(),
): boolean {
  if (!announcement.published) return false;
  if (announcement.publishAt > now) return false;
  if (announcement.expiresAt && announcement.expiresAt <= now) return false;
  return true;
}
