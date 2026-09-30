import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";

/** The platform owner's mark. Public for the same reason as the org logo. */
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { logoKey: true },
  });
  if (!settings?.logoKey) return new Response(null, { status: 404 });

  const file = await storage().get(settings.logoKey);
  if (!file) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.data.length),
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
