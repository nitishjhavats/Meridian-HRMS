import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { json, parseQuery, route } from "@/lib/http/handler";
import { listDocuments, uploadDocument } from "@/services/documents";

const MAX_BYTES = 10 * 1024 * 1024;

const querySchema = z.object({
  employeeId: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "EXPIRED"]).optional(),
});

export const GET = route(async (request, { ctx }) => {
  const filters = parseQuery(request, querySchema);
  return json({ documents: await listDocuments(ctx, filters) });
});

/** Multipart, because this carries a file. */
export const POST = route(async (request, { ctx }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("Expected a multipart form with the file attached.");
  }

  const upload = form.get("file");
  if (!(upload instanceof File) || upload.size === 0) {
    throw new ValidationError("Choose a file to upload.");
  }
  if (upload.size > MAX_BYTES) {
    throw new ValidationError("That file is too large. Use one under 10 MB.");
  }

  const employeeId = String(form.get("employeeId") ?? "");
  const title = String(form.get("title") ?? "").trim();
  if (!employeeId) throw new ValidationError("Say whose document this is.");
  if (title.length < 2) throw new ValidationError("Give the document a title.");

  const expiresOn = String(form.get("expiresOn") ?? "").trim();
  const replaces = String(form.get("replacesDocumentId") ?? "").trim();

  const result = await uploadDocument(
    ctx,
    {
      data: Buffer.from(await upload.arrayBuffer()),
      fileName: upload.name || "document",
      mimeType: upload.type || "application/octet-stream",
    },
    {
      employeeId,
      category: String(form.get("category") ?? "OTHER"),
      title,
      expiresOn: expiresOn || null,
      note: String(form.get("note") ?? "").trim() || undefined,
      replacesDocumentId: replaces || undefined,
    },
  );

  return json(result, { status: 201 });
});
