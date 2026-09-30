import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { ValidationError } from "@/lib/errors";
import { json, requestMeta, route } from "@/lib/http/handler";
import { markAttendance } from "@/services/attendance/checkIn";
import { MAX_SEQUENCE_FRAMES } from "@/lib/face/engine";

/**
 * Check in or out.
 *
 * Multipart, because the selfie is a real image file rather than a base64 blob
 * inflating a JSON body by a third. The client sends pixels and coordinates; it
 * never sends a face descriptor, a distance, or a verdict — all three are
 * produced on this side.
 */
const fieldsSchema = z.object({
  type: z.enum(["CHECK_IN", "CHECK_OUT"]),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  accuracyMeters: z.coerce.number().min(0).max(100_000).optional(),
  note: z.string().trim().max(300).optional(),
  deviceInfo: z.string().max(2_000).optional(),
  /**
   * The screen's "mark it anyway" escape, after the retries a reason is worth.
   *
   * A form field is a string, so this is compared rather than coerced --
   * `z.coerce.boolean()` would read the literal "false" as true, which is how a
   * checkbox that can only be ticked gets shipped.
   */
  acceptForReview: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const MAX_SELFIE_BYTES = 5 * 1024 * 1024;

export const POST = route(async (request) => {
  const ctx = await requireContext();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("Expected a multipart form with the photo attached.");
  }

  const fields = fieldsSchema.parse({
    type: form.get("type"),
    latitude: form.get("latitude") ?? undefined,
    longitude: form.get("longitude") ?? undefined,
    accuracyMeters: form.get("accuracyMeters") ?? undefined,
    note: form.get("note") ?? undefined,
    deviceInfo: form.get("deviceInfo") ?? undefined,
    /**
     * The field was declared in the schema and never read from the form, so
     * the escape parsed to `false` on every request and "Mark anyway" did
     * nothing: a person the check could not verify pressed it, was refused
     * again with the same message, and pressed it again. Seven times, on the
     * live instance, in one morning. The kiosk route read its own copy of the
     * field and worked; this one did not.
     */
    acceptForReview: form.get("acceptForReview") ?? undefined,
  });

  const upload = form.get("selfie");
  let selfie: { data: Buffer; fileName: string; mimeType: string } | null = null;

  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_SELFIE_BYTES) {
      throw new ValidationError("That photo is too large. Please retake it.");
    }
    selfie = {
      data: Buffer.from(await upload.arrayBuffer()),
      fileName: upload.name || "selfie.jpg",
      mimeType: upload.type || "image/jpeg",
    };
  }

  /**
   * The rest of the burst the selfie came from.
   *
   * Sent as repeated `frames` parts in capture order. They are read for the
   * blink check and thrown away -- only `selfie` is stored -- so the cap here
   * is about the work the server will do, not about storage. Anything beyond
   * `MAX_SEQUENCE_FRAMES` is ignored rather than refused: an over-eager client
   * should not cost somebody their attendance.
   */
  const frames: { data: Buffer; fileName: string; mimeType: string }[] = [];
  for (const part of form.getAll("frames").slice(0, MAX_SEQUENCE_FRAMES)) {
    if (!(part instanceof File) || part.size === 0) continue;
    if (part.size > MAX_SELFIE_BYTES) {
      throw new ValidationError("One of those frames is too large. Please retake the photo.");
    }
    frames.push({
      data: Buffer.from(await part.arrayBuffer()),
      fileName: part.name || "frame.jpg",
      mimeType: part.type || "image/jpeg",
    });
  }

  let deviceInfo: Record<string, unknown> | null = null;
  if (fields.deviceInfo) {
    try {
      deviceInfo = JSON.parse(fields.deviceInfo) as Record<string, unknown>;
    } catch {
      deviceInfo = null;
    }
  }

  const coordinates =
    fields.latitude != null && fields.longitude != null
      ? {
          latitude: fields.latitude,
          longitude: fields.longitude,
          accuracyMeters: fields.accuracyMeters ?? null,
        }
      : null;

  const result = await markAttendance(ctx, {
    type: fields.type,
    coordinates,
    selfie,
    frames,
    deviceInfo,
    note: fields.note,
    acceptForReview: fields.acceptForReview,
    ipAddress: requestMeta(request).ipAddress,
  });

  return json(result);
});
