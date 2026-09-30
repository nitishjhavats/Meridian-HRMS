import { json, route } from "@/lib/http/handler";
import {
  clearOrganizationStamp,
  readUploadedFile,
  setOrganizationStamp,
} from "@/services/org/branding";

/**
 * The company seal, printed beside the signature on a letter.
 *
 * Beside the logo route rather than under `settings/organisation`, because it
 * is the same kind of thing: an image belonging to the organisation, uploaded
 * the same way, guarded by the same permission.
 */
export const POST = route(async (request, { ctx }) => {
  return json(await setOrganizationStamp(ctx, await readUploadedFile(request)));
});

export const DELETE = route(async (_request, { ctx }) => {
  return json(await clearOrganizationStamp(ctx));
});
