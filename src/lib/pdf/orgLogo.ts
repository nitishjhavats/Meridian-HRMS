import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";

/**
 * An organisation's logo as a data URI, for a PDF.
 *
 * `@react-pdf/renderer` needs the bytes: it cannot fetch a URL from inside a
 * server render, and the CSP would refuse it anyway. Shared by letters and
 * payslips, both of which drew a name in type where a logo should have been —
 * the letter renderer had accepted a `logoDataUri` since it was written and
 * nothing ever supplied one.
 *
 * A logo that cannot be read is not an error. The document falls back to the
 * organisation's name, which is exactly what it did before.
 */
/**
 * Any stored image as a data URI, for a PDF.
 *
 * Same reasoning as the logo: `@react-pdf` needs the bytes, and an image that
 * cannot be read is not an error — the document renders without it.
 */
export async function storedImageDataUri(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    const file = await storage().get(key);
    if (!file) return null;
    return `data:${file.mimeType};base64,${file.data.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function organizationLogoDataUri(
  organizationId: string | null,
): Promise<string | null> {
  if (!organizationId) return null;
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoKey: true },
    });
    if (!org?.logoKey) return null;
    const file = await storage().get(org.logoKey);
    if (!file) return null;
    return `data:${file.mimeType};base64,${file.data.toString("base64")}`;
  } catch {
    return null;
  }
}
