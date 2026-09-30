import { json, noContent, route } from "@/lib/http/handler";
import { clearPlatformLogo, readUploadedFile, setPlatformLogo } from "@/services/org/branding";

/** The platform mark, which the installed app's icon is also generated from. */
export const POST = route(async (request, { ctx }) => {
  return json(await setPlatformLogo(ctx, await readUploadedFile(request)));
});

export const DELETE = route(async (_request, { ctx }) => {
  await clearPlatformLogo(ctx);
  return noContent();
});
