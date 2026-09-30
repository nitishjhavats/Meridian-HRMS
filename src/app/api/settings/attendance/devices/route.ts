import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, route } from "@/lib/http/handler";
import { createKioskDevice, listKioskDevices } from "@/services/attendance/settings";

export const GET = route(async () => {
  const ctx = await requireContext();
  // The locations come with the list because a device cannot be created without
  // one, and a second round-trip to populate one dropdown is pure ceremony.
  const [devices, locations, withoutWorkLocation] = await Promise.all([
    listKioskDevices(ctx),
    prisma.workLocation.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    // Counted here because a device limited to one location lists nobody who
    // has not been given one, and the moment to say so is before the choice is
    // made rather than at a reception desk afterwards.
    prisma.employee.count({
      where: { organizationId: ctx.organizationId!, active: true, workLocationId: null },
    }),
  ]);
  return json({ devices, locations, withoutWorkLocation });
});

const createSchema = z.object({
  label: z.string().trim().min(2).max(60),
  workLocationId: z.string().min(1),
  // zod strips what it does not declare, so a form field missing from here is
  // dropped silently rather than refused -- which is how a setting ships that
  // saves and does nothing.
  rosterScope: z.enum(["ORGANISATION", "WORK_LOCATION"]).optional(),
});

/** The password comes back once, here, and is never stored in the clear. */
export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, createSchema);
  return created(await createKioskDevice(ctx, body));
});
