import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { getTodayStatus } from "@/services/attendance/checkIn";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await getTodayStatus(ctx));
});
