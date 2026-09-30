import { json, route } from "@/lib/http/handler";
import {
  clearOrganizationSignature,
  readUploadedFile,
  setOrganizationSignature,
} from "@/services/org/branding";

/**
 * The authorised signatory's signature, for every letter this organisation
 * issues.
 *
 * Beside the stamp route, because it is the same kind of thing and now lives in
 * the same place. It used to be uploadable only from inside the letter-template
 * editor, one category at a time, so uploading it for the offer letter left the
 * other nine unsigned — and organisation settings, which already held the seal,
 * had nowhere to put it at all.
 */
export const POST = route(async (request, { ctx }) => {
  return json(await setOrganizationSignature(ctx, await readUploadedFile(request)));
});

export const DELETE = route(async (_request, { ctx }) => {
  return json(await clearOrganizationSignature(ctx));
});
