import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  getHolidayCatalogue,
  toggleCatalogueHoliday,
} from "@/services/org/holidayCatalogue";

const thisYear = () => new Date().getUTCFullYear();

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const year = Number(new URL(request.url).searchParams.get("year")) || thisYear();
  return json(await getHolidayCatalogue(ctx, year));
});

const patchSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  key: z.string().min(1).max(60),
  on: z.boolean(),
});

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json(await toggleCatalogueHoliday(ctx, body));
});
