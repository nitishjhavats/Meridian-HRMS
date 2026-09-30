import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { listResetRequests } from "@/services/auth/passwordReset";

export const GET = route(async () => {
  const ctx = await requireContext();
  // Deliberately never includes the OTP itself — it is fetched only by an
  // explicit release, which is separately audited.
  return json({ requests: await listResetRequests(ctx) });
});
