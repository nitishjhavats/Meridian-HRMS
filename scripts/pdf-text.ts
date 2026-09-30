import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Extracts the text a PDF actually draws.
 *
 * Used to verify generated documents: "the file is 3 KB and starts with %PDF"
 * says nothing about whether the salary figure made it onto the page.
 *
 * Handles both text-showing forms, because which one appears depends on the
 * generator — `@react-pdf` emits hex strings inside `TJ` arrays with kerning
 * numbers between them, while simpler writers emit `(literal) Tj`.
 *
 *   npx tsx scripts/pdf-text.ts <file.pdf>
 *
 * **This no longer reads the payslips and letters this product generates**, and
 * it fails by printing plausible-looking rubbish rather than by erroring. Since
 * the rupee sign forced a real font, `@react-pdf` embeds NotoSans as a *subset*
 * and the codes in the content stream are glyph indices in that subset, not
 * character codes -- so decoding them as text produces noise. Reading these
 * properly means following each font's `/ToUnicode` CMap, including its
 * `bfrange` form, which is a real piece of work and was not worth building.
 *
 * Two checks that do work on a subset-font PDF, and which are usually what you
 * actually wanted:
 *
 *   - the fonts are embedded:  grep for `/BaseFont` and expect `+NotoSans-`
 *   - a character is really drawn, not substituted: inflate the streams, find
 *     the `beginbfchar` pairs and look for the codepoint -- `20B9` being
 *     present is how the rupee sign was confirmed rather than assumed.
 */

/** `(a\)b)` and `<48656c6c6f>` both decode to plain text. */
function decodeString(token: string): string {
  if (token.startsWith("<")) {
    const hex = token.slice(1, -1).replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }
  return token.slice(1, -1).replace(/\\([()\\])/g, "$1");
}

export function pdfText(pdf: Buffer): string[] {
  const runs: string[] = [];

  for (const stream of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body = Buffer.from(stream[1]!, "latin1");
    try {
      body = inflateSync(body);
    } catch {
      // Not compressed; read it as it is.
    }
    const text = body.toString("latin1");

    // `[<hex> 100 (lit) ...] TJ` — one array is one visual run, so the pieces
    // are joined rather than reported separately.
    for (const arr of text.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const parts = arr[1]!.matchAll(/<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\)/g);
      const joined = [...parts].map((p) => decodeString(p[0])).join("");
      if (joined.trim()) runs.push(joined);
    }

    // `(literal) Tj`
    for (const t of text.matchAll(/(\((?:[^()\\]|\\.)*\))\s*Tj/g)) {
      const value = decodeString(t[1]!);
      if (value.trim()) runs.push(value);
    }
  }

  return runs;
}

const file = process.argv[2];
if (file) {
  const runs = pdfText(readFileSync(file));
  console.log(`${runs.length} text runs drawn:`);
  for (const run of runs) console.log("  ", run.slice(0, 110));
}
