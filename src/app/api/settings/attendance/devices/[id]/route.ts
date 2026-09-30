import { z } from "zod";
import { json, noContent, parseBody, route } from "@/lib/http/handler";
import {
  regenerateKioskPassword,
  revokeKioskDevice,
  updateKioskDevice,
} from "@/services/attendance/settings";

/**
 * `PATCH` changes a device that is already standing somewhere; `POST` issues a
 * new password for it; `DELETE` retires it. The password shown at creation is
 * never recoverable, so without the second a forgotten one meant deleting the
 * device and making another -- and without the first, so did renaming it.
 */
const updateSchema = z.object({
  label: z.string().trim().min(2).max(60).optional(),
  workLocationId: z.string().min(1).optional(),
  rosterScope: z.enum(["ORGANISATION", "WORK_LOCATION"]).optional(),
});

export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, updateSchema);
  return json(await updateKioskDevice(ctx, params.id, body));
});
const passwordSchema = z.object({
  // Absent means "generate one". Present means an administrator chose it, and
  // it goes through the same strength rules as every other password here.
  password: z.string().min(1).max(200).optional(),
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const raw: unknown = await request.json().catch(() => ({}));
  const body = passwordSchema.parse(raw ?? {});
  return json(await regenerateKioskPassword(ctx, params.id, body.password));
});

export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  await revokeKioskDevice(ctx, params.id);
  return noContent();
});
