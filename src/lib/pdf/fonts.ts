import { existsSync } from "node:fs";
import path from "node:path";
import { Font } from "@react-pdf/renderer";
import { formatPaise, type Money } from "@/domain/money";

/**
 * The font every PDF is drawn in, and what that decides about money.
 *
 * PDFs here used to use Helvetica — one of the fourteen fonts every reader has
 * built in, and therefore free. Its WinAnsi encoding has no glyph for U+20B9,
 * so a rupee sign printed as a superscript one: `₹57,674.00` came out looking
 * like `¹57,674.00`, so the product wrote "Rs 57,674.00" instead -- the only
 * honest option available without a font. That substitution still exists, as
 * the fallback arm of `formatPdfMoney` below, for a deployment that has lost
 * its font files.
 *
 * Noto Sans has the glyph. It is downloaded by `npm run fonts` rather than
 * committed, like the face models, because this repo carries no binary nobody
 * can regenerate.
 *
 * **If the font is missing, money falls back to "Rs".** A payslip that prints
 * the wrong character is worse than one that spells it out, and a deployment
 * that lost its font files should degrade rather than render nonsense or throw
 * on every PDF in the product.
 */

const FONT_DIR = process.env.PDF_FONT_DIR ?? path.join(process.cwd(), "fonts");
const REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

const available = existsSync(REGULAR) && existsSync(BOLD);

if (available) {
  Font.register({
    family: "Noto Sans",
    fonts: [
      { src: REGULAR, fontWeight: 400 },
      { src: BOLD, fontWeight: 700 },
    ],
  });
  // The default hyphenation callback breaks words mid-syllable in a way that
  // looks like a typo on a letter somebody signs.
  Font.registerHyphenationCallback((word) => [word]);
} else {
  console.warn(
    "[pdf] fonts/NotoSans-*.ttf not found — PDFs will use Helvetica and write money as \"Rs\". Run `npm run fonts`.",
  );
}

/** What every PDF stylesheet should use for `fontFamily`. */
export const PDF_FONT = available ? "Noto Sans" : "Helvetica";

/** The bold face's name, which differs between the two. */
export const PDF_FONT_BOLD = available ? "Noto Sans" : "Helvetica-Bold";

/** Whether the rupee sign will actually render. Exported so a caller can say so. */
export const PDF_HAS_RUPEE = available;

/**
 * Money, formatted for a PDF.
 *
 * One function, so no renderer has to decide anything. With the font present
 * this is `₹57,674.00`; without it, the "Rs 57,674.00" the product printed
 * before the font existed.
 *
 * The substitution lives here rather than beside `formatPaise` in the domain
 * layer, where it used to be a second exported money formatter called
 * `formatPaiseAscii`. Two public formatters is one too many — the choice is not
 * a property of the money, it is a property of whether this process can draw
 * the glyph, which is knowledge that belongs to exactly this file.
 *
 * `hasGlyph` is a parameter only so that both branches can be tested. Nothing
 * in the product passes it; leaving it out asks the module, which is the
 * answer for the running process.
 */
export function formatPdfMoney(paise: Money, currency = "INR", hasGlyph = available): string {
  const formatted = formatPaise(paise, currency);
  if (hasGlyph || currency !== "INR") return formatted;
  return formatted.replace("₹", "Rs ");
}

/**
 * Any text on its way into a PDF, made safe to draw.
 *
 * `formatPdfMoney` covers the numbers a renderer formats itself. It cannot
 * cover a rupee sign that arrived inside a *string* -- and several do:
 *
 *   - the payroll engine's warnings, formatted with the domain formatter and
 *     stored on the item, then printed into the payslip's notes;
 *   - a letter body, where an administrator can type whatever they like into
 *     the template editor, rupee signs included;
 *   - an adjustment's note, a reason, an F&F remark.
 *
 * Without the embedded font the renderer falls back to Helvetica, whose WinAnsi
 * encoding has no U+20B9 and draws a superscript one. So a payslip could show
 * "Rs 24,596.77" in its table and "18,000.00" with a stray mark in the note
 * directly beneath -- the same amount, two spellings, one of them broken.
 *
 * Applied at the boundary rather than at each source, because the property it
 * depends on is "this process cannot draw that glyph", which is knowledge that
 * belongs here and nowhere else. It also means the next person to write a
 * warning does not have to know any of this.
 */
export function toPdfSafeText<T extends string | null | undefined>(
  text: T,
  hasGlyph = available,
): T {
  if (hasGlyph || !text) return text;
  return text.replace(/\u20b9\s?/g, "Rs ") as T;
}
