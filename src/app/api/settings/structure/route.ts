import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  getStructure,
  removeDesignationReporting,
  reorderDesignations,
  saveDepartment,
  saveDesignation,
  setDesignationReporting,
  saveWorkLocation,
  assignWorkLocation,
  copyWorkLocationRules,
} from "@/services/org/structure";

/**
 * One endpoint for one screen.
 *
 * Departments, designations and work locations are edited together and never
 * apart, and a discriminated union keeps the dispatch explicit and typed rather
 * than spreading three near-identical route files across the tree.
 */
export const GET = route(async (_request, { ctx }) => {
  return json(await getStructure(ctx));
});

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("department"),
    id: z.string().optional(),
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().max(16).optional(),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("designation"),
    id: z.string().optional(),
    title: z.string().trim().min(2).max(80),
    level: z.number().int().min(0).max(20).optional(),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("designation-order"),
    /** The complete list, once each, in the order to store. */
    orderedIds: z.array(z.string()).min(1).max(200),
  }),
  z.object({
    kind: z.literal("designation-reporting"),
    designationId: z.string(),
    reportsToDesignationId: z.string(),
    type: z.enum(["PRIMARY", "SECONDARY"]).optional(),
    /** True removes the edge instead of creating it. */
    remove: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("location"),
    id: z.string().optional(),
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    latitude: z.number(),
    longitude: z.number(),
    radiusMeters: z.number().int(),
    requireGps: z.boolean().optional(),
    requireSelfie: z.boolean().optional(),
    active: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("location-rules-copy"),
    fromId: z.string().min(1),
    /**
     * The branches to write the rules onto.
     *
     * The source's own id is filtered out in the service rather than refused
     * here: selecting it is something an administrator can do with one careless
     * click, and it changes nothing.
     */
    toIds: z.array(z.string()).min(1).max(200),
  }),
  z.object({
    kind: z.literal("location-assign"),
    employeeIds: z.array(z.string()).min(1).max(1000),
    /**
     * Null means "take them off a branch".
     *
     * `.nullable()` and not `.optional()`: an absent field would be
     * indistinguishable from an explicit clear, and a bulk assign that cannot
     * be undone is worse than one that does not exist.
     */
    workLocationId: z.string().nullable(),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);

  switch (body.kind) {
    case "department":
      return json({ department: await saveDepartment(ctx, body) });
    case "designation":
      return json({ designation: await saveDesignation(ctx, body) });
    case "designation-order":
      return json(await reorderDesignations(ctx, body.orderedIds));
    case "designation-reporting":
      return json(
        body.remove
          ? await removeDesignationReporting(ctx, body)
          : { edge: await setDesignationReporting(ctx, body) },
      );
    case "location":
      return json({ location: await saveWorkLocation(ctx, body) });
    case "location-rules-copy":
      return json(await copyWorkLocationRules(ctx, body));
    case "location-assign":
      return json(await assignWorkLocation(ctx, body));
  }
});
