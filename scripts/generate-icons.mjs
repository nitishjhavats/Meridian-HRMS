/**
 * Rasterises the HRMS mark into the shipped icon set.
 *
 *   npm run icons
 *
 * The mark itself is `scripts/logo.mjs` — SVG, so it is text and the repo still
 * carries no binary nobody can regenerate, which was the whole point of the
 * previous hand-plotted version. What that version could not do is *design*
 * anything: it looped over pixels writing a plain `H`, with no antialiasing
 * worth the name and no idea behind the letter.
 *
 * sharp is a dependency already — the branded icon route composes with it at
 * runtime — so rasterising here costs nothing new.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { markSvg } from "./logo.mjs";

const OUT_DIR = path.resolve("public/icons");

/**
 * The largest square that survives a circular mask of 80% diameter.
 *
 * Android crops a maskable icon to whatever shape the launcher likes, and the
 * guaranteed-safe region is a circle of 80% of the width. `0.8 / SQRT2` is the
 * square inside it. The same number is in `src/lib/branding/icon.ts`, for the
 * same reason, applied to an uploaded logo.
 */
const MASKABLE_SAFE = 0.8 / Math.SQRT2;

const TARGETS = [
  { name: "icon-192.png", size: 192, shape: "rounded", inset: 1 },
  { name: "icon-256.png", size: 256, shape: "rounded", inset: 1 },
  { name: "icon-384.png", size: 384, shape: "rounded", inset: 1 },
  { name: "icon-512.png", size: 512, shape: "rounded", inset: 1 },
  // Full bleed, glyph inside the safe circle: the launcher supplies the shape.
  { name: "maskable-192.png", size: 192, shape: "square", inset: MASKABLE_SAFE },
  { name: "maskable-512.png", size: 512, shape: "square", inset: MASKABLE_SAFE },
  // iOS rounds this itself and does not read the manifest for it.
  { name: "apple-touch-icon.png", size: 180, shape: "rounded", inset: 1 },
  // A browser tab, at sixteen effective pixels. The glyph is drawn slightly
  // larger because there is no room for a margin to be seen at all.
  { name: "favicon-32.png", size: 32, shape: "rounded", inset: 1.08 },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const target of TARGETS) {
  const svg = markSvg({ size: target.size, shape: target.shape, inset: target.inset });
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(path.join(OUT_DIR, target.name), png);
  console.log(`  ${target.name.padEnd(24)} ${String(png.length).padStart(7)} bytes`);
}

console.log(`\nWrote ${TARGETS.length} icons to ${OUT_DIR}`);
