/**
 * Downloads the PDF font.
 *
 *   npm run fonts
 *
 * Every PDF this product renders — payslips, letters, full-and-final
 * settlements — was drawn in Helvetica, one of the fourteen fonts every PDF
 * reader has built in. Helvetica's WinAnsi encoding has no glyph for U+20B9,
 * the rupee sign, so `₹57,674.00` printed as a superscript one followed by the
 * number, so the product wrote "Rs 57,674.00" instead -- the only honest thing
 * to do without a font, and still what `formatPdfMoney` falls back to if these
 * files are missing.
 *
 * Noto Sans has the glyph, is OFL-licensed, and covers Latin comfortably.
 * Roughly 1.1 MB for the two weights.
 *
 * Not committed, for the same reason the face models are not: this repo carries
 * no binary that nobody can regenerate. The Dockerfile runs this in its own
 * stage so editing a line of TypeScript does not re-download it.
 */

import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const BASE = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans";

const FONTS = [
  { file: "NotoSans-Regular.ttf", url: `${BASE}/NotoSans-Regular.ttf`, approxBytes: 569_208 },
  { file: "NotoSans-Bold.ttf", url: `${BASE}/NotoSans-Bold.ttf`, approxBytes: 575_740 },
];

const dir = path.resolve("fonts");
await mkdir(dir, { recursive: true });

for (const font of FONTS) {
  const target = path.join(dir, font.file);

  try {
    const existing = await stat(target);
    // Not an equality check: a font can be updated upstream without becoming
    // the wrong font, and re-downloading on every build would be worse than
    // tolerating a few kilobytes of drift. A wildly different size is the
    // signal worth acting on.
    if (Math.abs(existing.size - font.approxBytes) < font.approxBytes * 0.25) {
      console.log(`  ${font.file.padEnd(22)} already present (${existing.size} bytes)`);
      continue;
    }
    console.log(`  ${font.file.padEnd(22)} unexpected size, re-downloading`);
  } catch {
    // Not there yet.
  }

  process.stdout.write(`  ${font.file.padEnd(22)} downloading… `);
  const response = await fetch(font.url);
  if (!response.ok || !response.body) {
    console.error(`FAILED (${response.status})`);
    process.exit(1);
  }
  await pipeline(response.body, createWriteStream(target));
  const written = await stat(target);
  console.log(`${written.size} bytes`);
}

console.log("\nPDF font ready. Money prints with ₹ rather than \"Rs\".");
