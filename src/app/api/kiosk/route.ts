import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { getKioskContext, getKioskRoster } from "@/services/attendance/kiosk";

/** Which device this is, and everybody it may mark. One request, one screen. */
export const GET = route(async () => {
  const ctx = await requireContext();
  const [device, roster] = await Promise.all([getKioskContext(ctx), getKioskRoster(ctx)]);
  return json({ device, roster });
});
