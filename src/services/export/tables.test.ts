import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { TABLES } from "./tables";

/**
 * The export reaches Prisma delegates by name, so a typo here is invisible to
 * the compiler and would only show up as a failed export. These check the list
 * against the schema itself.
 *
 * `Prisma.dmmf` is static metadata generated alongside the client — reading it
 * needs no database and opens no connection.
 */

const MODELS = Prisma.dmmf.datamodel.models;
const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Models an export deliberately leaves out.
 *
 * This list is half the test: when somebody adds a model to the schema, it
 * belongs in `TABLES` or in here, and the assertion below makes them decide
 * rather than letting a new table quietly go unexported.
 */
const EXCLUDED = new Set([
  // Platform-level, not an organisation's data.
  "PlatformSetting",
  "Coupon",
  "CouponRedemption",
  // The owner's advance codes. Platform-side like coupons; the order they
  // confirmed is exported with the organisation's orders.
  "PaymentCode",
  "FeatureGrant",
  "SeatUsageSnapshot",
  // Security telemetry and secrets, not company records.
  "Session",
  "UserPermissionGrant",
  "LoginEvent",
  "PasswordResetRequest",
  "AuditLog", // exported separately, capped to the most recent rows
  // Spent one-shot codes. The hashes carry nothing, and the AttendanceEvent
  // already records that a bypass happened and who authorised it.
  "AttendancePin",
  "DataExportJob", // holds the passphrases of other exports
  "AiConfig", // holds an API key
  // Bytes and transient rows.
  "FileObject",
  "Notification",
  "PushSubscription",
  "RateLimitCounter",
  // Handled on their own.
  "Organization",
  // The addresses the organisation has lived at. Routing, not a company
  // record: it exists so an old /o/<slug> keeps resolving, and it travels with
  // the Organization row rather than as a table of its own.
  "OrganizationSlug",
  // Reachable, but noise: likes carry nothing a comment does not.
  "AnnouncementLike",
  "PaymentOrderEvent",
  // Private messages between two employees. An organisation's data export is
  // downloaded by its owner under a permission described as "your data" -- it
  // must not be the file that hands them every private conversation in the
  // company. The only way to read a conversation is `chat.export`, one pair at
  // a time, with a written reason on the audit log and both people told.
  "ChatThread",
  "ChatMessage",
  "ChatBlock",
  // The reason and the reporter, but never the messages.
  "ChatReport",
]);

describe("export tables", () => {
  it("names only models that exist", () => {
    const known = new Set(MODELS.map((m) => delegateName(m.name)));
    const unknown = TABLES.map((t) => t.model).filter((model) => !known.has(model));
    expect(unknown).toEqual([]);
  });

  it("lists each table once", () => {
    const names = TABLES.map((t) => t.model);
    expect(names).toHaveLength(new Set(names).size);
  });

  it("accounts for every model in the schema", () => {
    const covered = new Set(TABLES.map((t) => t.model));
    const unaccounted = MODELS.map((m) => m.name).filter(
      (name) => !EXCLUDED.has(name) && !covered.has(delegateName(name)),
    );
    expect(unaccounted).toEqual([]);
  });

  it("filters a table on a field or relation that model actually has", () => {
    for (const table of TABLES) {
      const model = MODELS.find((m) => delegateName(m.name) === table.model);
      const [field] = Object.keys(table.where("org-1"));
      expect(
        model?.fields.some((f) => f.name === field),
        `${table.model} is filtered on "${field}", which it does not have`,
      ).toBe(true);
    }
  });

  it("scopes every table to one organisation", () => {
    // Nothing may be exported unscoped: a `where` that ignores its argument
    // would hand one tenant another tenant's rows.
    for (const table of TABLES) {
      expect(JSON.stringify(table.where("org-1"))).toContain("org-1");
    }
  });
});
