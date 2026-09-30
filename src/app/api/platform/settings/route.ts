import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { json, parseBody, route } from "@/lib/http/handler";
import { getSettings, updateSettings } from "@/services/platform/settings";

export const GET = route(async () => {
  const ctx = await requireContext();
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.settings.manage");
  return json({ settings: await getSettings() });
});

const patchSchema = z.object({
  pricePerUserPaise: z.number().int().min(0).optional(),
  paymentUpiId: z.string().trim().max(80).optional(),
  // Shape is checked in the domain, which owns the message people read.
  invoicePrefix: z.string().trim().max(8).optional(),
  paymentPayeeName: z.string().trim().max(80).optional(),
  paymentWindowMinutes: z.number().int().min(15).max(10_080).optional(),
  confirmationMode: z.enum(["UTR", "CODE", "BOTH"]).optional(),
  otpTtlMinutes: z.number().int().min(5).max(120).optional(),
  defaultTrialDays: z.number().int().min(1).max(365).optional(),
  seatGraceDays: z.number().int().min(0).max(90).optional(),
  selfieRetentionDays: z.number().int().min(1).max(3_650).optional(),
  defaultAiModel: z.string().trim().max(80).optional(),
  maintenanceMode: z.boolean().optional(),
  selfSignupEnabled: z.boolean().optional(),
});

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json({ settings: await updateSettings(ctx, body) });
});
