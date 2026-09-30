import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, route } from "@/lib/http/handler";
import {
  getPinAuthorities,
  grantPinAuthority,
  revokePinAuthority,
} from "@/services/attendance/pinAuthority";

/**
 * Who may hand out an attendance PIN.
 *
 * The list, the designations and the people all come back together: the screen
 * cannot offer a choice without them, and three round-trips to fill two
 * dropdowns is ceremony.
 */
export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await getPinAuthorities(ctx));
});

const grantSchema = z
  .object({
    designationId: z.string().min(1).optional(),
    employeeId: z.string().min(1).optional(),
    role: z.enum(["HR_MANAGER", "MANAGER", "TEAM_LEAD", "SUPERVISOR", "TEAM_MEMBER"]).optional(),
  })
  // The service refuses anything but exactly one as well; this just says so
  // earlier and in the language of the form.
  .refine((v) => [v.designationId, v.employeeId, v.role].filter(Boolean).length === 1, {
    message: "Choose a role, a designation, or one person.",
  });

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, grantSchema);
  await grantPinAuthority(ctx, body);
  return created(await getPinAuthorities(ctx));
});

const revokeSchema = z.object({ id: z.string().min(1) });

export const DELETE = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, revokeSchema);
  await revokePinAuthority(ctx, body.id);
  return json(await getPinAuthorities(ctx));
});
