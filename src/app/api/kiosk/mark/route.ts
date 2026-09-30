import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { ValidationError } from "@/lib/errors";
import { MAX_SEQUENCE_FRAMES } from "@/lib/face/engine";
import { requestMeta } from "@/lib/http/handler";
import { markAtKiosk, type KioskBypassInput } from "@/services/attendance/kiosk";

/**
 * Multipart, because the ordinary path carries a photo.
 *
 * The bypass paths ride in the same request as plain fields rather than getting
 * their own endpoint: they are the same action with the identity established a
 * different way, and splitting them would mean two places to keep the tenancy
 * checks correct.
 */
const MAX_SELFIE_BYTES = 5 * 1024 * 1024;

export const POST = route(async (request) => {
  const ctx = await requireContext();

  const form = await request.formData().catch(() => null);
  if (!form) throw new ValidationError("Nothing was submitted.");

  const employeeId = String(form.get("employeeId") ?? "");
  const type = String(form.get("type") ?? "");
  if (!employeeId) throw new ValidationError("Choose who is marking attendance.");
  if (type !== "CHECK_IN" && type !== "CHECK_OUT") {
    throw new ValidationError("That is not a check-in or a check-out.");
  }

  let bypass: KioskBypassInput | null = null;
  const pin = form.get("pin");
  const supervisorEmail = form.get("supervisorEmail");

  if (typeof pin === "string" && pin.trim()) {
    bypass = { kind: "PIN", code: pin.trim() };
  } else if (typeof supervisorEmail === "string" && supervisorEmail.trim()) {
    bypass = {
      kind: "SUPERVISOR",
      email: supervisorEmail.trim(),
      password: String(form.get("supervisorPassword") ?? ""),
      reason: String(form.get("reason") ?? ""),
    };
  }

  let selfie: { data: Buffer; fileName: string; mimeType: string } | null = null;
  const file = form.get("selfie");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_SELFIE_BYTES) throw new ValidationError("That photo is too large.");
    selfie = {
      data: Buffer.from(await file.arrayBuffer()),
      fileName: file.name || "selfie.jpg",
      mimeType: file.type || "image/jpeg",
    };
  }

  /**
   * The rest of the burst, for the blink check.
   *
   * Anything beyond the cap is ignored rather than refused: an over-eager
   * client should not cost somebody standing at a reception desk their
   * attendance.
   */
  const frames: { data: Buffer; fileName: string; mimeType: string }[] = [];
  for (const part of form.getAll("frames").slice(0, MAX_SEQUENCE_FRAMES)) {
    if (!(part instanceof File) || part.size === 0) continue;
    if (part.size > MAX_SELFIE_BYTES) throw new ValidationError("One of those frames is too large.");
    frames.push({
      data: Buffer.from(await part.arrayBuffer()),
      fileName: part.name || "frame.jpg",
      mimeType: part.type || "image/jpeg",
    });
  }

  let deviceInfo: Record<string, unknown> | null = null;
  const raw = form.get("deviceInfo");
  if (typeof raw === "string" && raw) {
    try {
      deviceInfo = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      deviceInfo = null;
    }
  }

  return json(
    await markAtKiosk(ctx, {
      employeeId,
      type,
      selfie,
      frames,
      bypass,
      // Compared, not coerced: `Boolean("false")` is true, which is how a
      // checkbox that can only be ticked gets shipped.
      acceptForReview: form.get("acceptForReview") === "true",
      deviceInfo,
      ipAddress: requestMeta(request).ipAddress,
    }),
  );
});
