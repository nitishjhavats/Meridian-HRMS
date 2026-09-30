/**
 * The HRMS mark, as SVG.
 *
 * **The idea.** An `H` whose left stem is a person: the stem stops short, a
 * circle sits above it as a head, and the crossbar meets it at shoulder height.
 * The right stem runs full height as a column. So the mark reads as the letter
 * and as *a person standing beside a structure* at the same time — which is
 * what an HR system is, and is a great deal more than the previous mark, a
 * plain hand-plotted `H` with no idea in it at all.
 *
 * **Why it survives 32 pixels.** One concept, four shapes, no strokes thinner
 * than 9.5% of the frame, and no detail that depends on a gap smaller than
 * 2.5%. Everything is a rounded rectangle or a circle, so the rasteriser has
 * nothing to alias badly. It is monochrome on a gradient — no second colour to
 * turn to mud.
 *
 * **Why SVG.** The old generator hand-plotted RGBA and hand-encoded PNG so the
 * repo would carry no binary nobody could regenerate. That reason is good and
 * is kept: this is text too, and `npm run icons` rasterises it. What changes is
 * that the shapes are now described rather than looped over, so the mark can be
 * *designed* instead of computed — and sharp antialiases it properly, which a
 * hand-written loop was never going to do.
 */

/** Kept from the previous mark, and matching `theme_color` in the manifest. */
export const BRAND_TOP = "#3b4cca";
export const BRAND_BOTTOM = "#25339c";
/** The ground a maskable icon bleeds to. Matches `background_color`. */
export const BRAND_GROUND = "#f7f8fb";

/**
 * The glyph, on a 0–1 grid, in the middle of its own box.
 *
 * Laid out once here so every size, every variant and the favicon are the same
 * drawing at different scales rather than three drawings that drift.
 */
function glyph(fill) {
  const parts = [
    // Right stem: the column, full height.
    `<rect x="60.5" y="26" width="9.5" height="48" rx="4.75" fill="${fill}"/>`,
    // Left stem: the body. Stops short of the top to leave room for a head.
    `<rect x="30" y="43.5" width="9.5" height="30.5" rx="4.75" fill="${fill}"/>`,
    // The head. Its gap from the stem is 2.5% of the frame — the smallest
    // feature in the mark, and still a clear pixel at 32px.
    `<circle cx="34.75" cy="33.5" r="7.5" fill="${fill}"/>`,
    // The crossbar, at shoulder height: the bar of the H, and the line that
    // joins the person to the column.
    `<rect x="30" y="49.5" width="40" height="8" rx="4" fill="${fill}"/>`,
  ];
  return parts.join("");
}

/**
 * One icon.
 *
 * `shape` is what the ground is:
 *   - `rounded` — a squircle, for the plain icon and apple-touch-icon;
 *   - `square`  — full bleed, for a maskable icon the launcher crops itself;
 *   - `circle`  — for anywhere the mark has to draw its own circle.
 *
 * `inset` shrinks the glyph inside the ground. A maskable icon needs it small
 * enough to survive a circular crop; the largest square inside an 80%-diameter
 * safe circle is `0.8 / SQRT2`, so the glyph is drawn at that.
 */
export function markSvg({ size = 512, shape = "rounded", inset = 1 } = {}) {
  const ground =
    shape === "square"
      ? `<rect width="100" height="100" fill="url(#g)"/>`
      : shape === "circle"
        ? `<circle cx="50" cy="50" r="50" fill="url(#g)"/>`
        : `<rect width="100" height="100" rx="22" fill="url(#g)"/>`;

  // Scale about the centre, so the glyph shrinks in place.
  const scale = inset;
  const shift = (1 - scale) * 50;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND_TOP}"/>
      <stop offset="1" stop-color="${BRAND_BOTTOM}"/>
    </linearGradient>
  </defs>
  ${ground}
  <g transform="translate(${shift} ${shift}) scale(${scale})">${glyph("#ffffff")}</g>
</svg>`;
}

/**
 * The mark on its own, no ground, in one colour.
 *
 * For anywhere the mark sits on a surface the product already controls — a
 * letterhead, a loading state — where a tile of its own would be a second box
 * inside a box.
 */
export function markGlyphSvg({ size = 512, fill = BRAND_TOP } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${glyph(
    fill,
  )}</svg>`;
}
