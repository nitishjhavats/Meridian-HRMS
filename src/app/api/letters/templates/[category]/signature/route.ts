import { json, route } from "@/lib/http/handler";
import { readUploadedFile } from "@/services/org/branding";
import { clearFrameworkSignature, setFrameworkSignature } from "@/services/letters/templates";

/**
 * The signature image for one letter type.
 *
 * Its own endpoint rather than a field on the framework PUT, because that route
 * parses JSON and this is multipart — and because uploading a signature and
 * editing the wording are separate acts that should not be able to fail
 * together.
 */
export const POST = route<{ category: string }>(async (request, { ctx, params }) => {
  return json({
    framework: await setFrameworkSignature(ctx, params.category, await readUploadedFile(request)),
  });
});

export const DELETE = route<{ category: string }>(async (_request, { ctx, params }) => {
  return json({ framework: await clearFrameworkSignature(ctx, params.category) });
});
