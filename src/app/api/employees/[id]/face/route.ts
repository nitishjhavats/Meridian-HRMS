import { requireContext } from "@/lib/auth/context";
import { ValidationError } from "@/lib/errors";
import { json, noContent, route } from "@/lib/http/handler";
import {
  enrolFace,
  getEnrolmentStatus,
  removeFaceEnrolment,
} from "@/services/employees/faceEnrolment";

const MAX_BYTES = 5 * 1024 * 1024;

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await getEnrolmentStatus(ctx, params.id));
});

/** Enrols the reference photo attendance selfies are matched against. */
export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("Expected a multipart form with the photo attached.");
  }

  const upload = form.get("photo");
  if (!(upload instanceof File) || upload.size === 0) {
    throw new ValidationError("Choose a photo to enrol.");
  }
  if (upload.size > MAX_BYTES) {
    throw new ValidationError("That photo is too large. Use one under 5 MB.");
  }

  const result = await enrolFace(
    ctx,
    params.id,
    {
      data: Buffer.from(await upload.arrayBuffer()),
      fileName: upload.name || "reference.jpg",
      mimeType: upload.type || "image/jpeg",
    },
    { consent: form.get("consent") === "true" },
  );

  // The descriptor itself never leaves the server.
  return json({
    enrolledAt: result.enrolledAt,
    quality: Number(result.quality.toFixed(3)),
    photoUrl: `/api/files/${result.photoKey}`,
  });
});

export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  await removeFaceEnrolment(ctx, params.id);
  return noContent();
});
