import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { changeOwnPassword } from "@/services/auth/changePassword";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(1, "Enter a new password."),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return json(await changeOwnPassword(ctx, body));
});
