import { json, noContent, route } from "@/lib/http/handler";
import {
  clearOrganizationLogo,
  readUploadedFile,
  setOrganizationLogo,
} from "@/services/org/branding";

/** The organisation's own mark, shown beside its name once signed in. */
export const POST = route(async (request, { ctx }) => {
  return json(await setOrganizationLogo(ctx, await readUploadedFile(request)));
});

export const DELETE = route(async (_request, { ctx }) => {
  await clearOrganizationLogo(ctx);
  return noContent();
});
