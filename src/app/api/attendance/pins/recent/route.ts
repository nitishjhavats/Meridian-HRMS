import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { listRecentPins } from "@/services/attendance/pinAuthority";

/** The PINs issued in the last day: everybody's for an administrator, one's own otherwise. */
export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ pins: await listRecentPins(ctx) });
});
