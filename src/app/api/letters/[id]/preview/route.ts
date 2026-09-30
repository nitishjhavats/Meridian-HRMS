import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/http/handler";
import { previewLetterPdf } from "@/services/letters";

/**
 * A draft letter as a PDF, before it is issued.
 *
 * There was no way to look at a letter without issuing one: the only caller of
 * `renderLetterPdf` in the product was `issueLetter`, which refuses outright
 * while any placeholder is unresolved. So an organisation could not check its
 * own letterhead, its signature block or its wording except by sending a real
 * letter to a real employee and reading that.
 *
 * A missing value is not an error here. `renderTemplate` has always rendered
 * `[Monthly salary]` and reported a problem beside it; `canIssue` is the
 * separate decision, and it still governs issuing. The page carries a DRAFT
 * watermark so a preview can never be mistaken for the real thing, and nothing
 * is stored, audited or marked issued.
 *
 * `inline`, so it opens in the browser's own viewer — the point is to look at
 * it, and a download that has to be found in a folder is not looking.
 */
export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_request, { params }) => {
  const ctx = await requireContext();
  const { pdf } = await previewLetterPdf(ctx, params.id);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="letter-draft.pdf"',
      // Never cached: a draft is being edited, and the next look must show the
      // edit rather than the last render.
      "Cache-Control": "no-store",
    },
  });
});
