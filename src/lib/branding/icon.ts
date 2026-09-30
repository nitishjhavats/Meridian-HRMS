/**
 * Drawing a home-screen icon from whatever logo this instance is branded with.
 *
 * Its own module rather than inline in the route, because the thing worth
 * testing here is a measurement — where the artwork ends up inside the frame —
 * and that cannot be measured through a route handler that first needs a
 * database and a storage adapter.
 */

/** The ground the artwork sits on. Matches `background_color` in the manifest. */
export const ICON_BACKGROUND = { r: 247, g: 248, b: 251, alpha: 1 } as const;

/**
 * How much of the frame the artwork may use, as a fraction of the width.
 *
 * The safe zone for a maskable icon is a **circle** of 80% diameter, and the
 * largest square that fits inside it is `0.8 / SQRT2`. Content laid out inside
 * that square survives any mask a launcher applies; content outside it does
 * not, and the corners are where a wide logo loses its edges.
 */
export const ICON_SAFE_FRACTION = 0.566;

/**
 * The share of the frame a launcher promises to keep on a maskable icon.
 *
 * Android crops a maskable icon to its own shape and guarantees only the
 * middle 80% survives. A logo that is already a designed tile is not laid out
 * inside a smaller square -- the whole tile is scaled to this, so whatever
 * margin its designer left is preserved in proportion.
 */
export const MASKABLE_SAFE_FRACTION = 0.8;

/**
 * How much of the drawn circle a designed tile fills.
 *
 * Not 1. The Broadmate mark reaches **96.7%** of its tile's inscribed radius,
 * so a circle drawn at the full radius leaves it four pixels from the edge at
 * 512 -- and every launcher that insets an icon even slightly, or antialiases
 * the rim, shaves the ring. Reported as exactly that: "kata hua lag raha hai".
 *
 * At 0.9 the mark lands at about 0.87 of the radius with visible ground all the
 * way round, which is the margin a designed icon has and the reason it survives
 * being put through somebody else's mask.
 */
export const TILE_IN_CIRCLE = 0.9;

export type IconVariant = "any" | "maskable";

/** A flat corner colour, or `null` when the four corners disagree. */
async function tileGround(
  source: Buffer | Uint8Array,
): Promise<{ r: number; g: number; b: number } | null> {
  const sharp = (await import("sharp")).default;

  // A 32-square downsample averages each corner over a sixteenth of the width,
  // so a single stray pixel or a JPEG artefact cannot decide this.
  const N = 32;
  const { data } = await sharp(source)
    .resize(N, N, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const at = (x: number, y: number) => {
    const i = (y * N + x) * 3;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const;
  };
  const corners = [at(0, 0), at(N - 1, 0), at(0, N - 1), at(N - 1, N - 1)];
  const first = corners[0]!;

  // Corners that disagree mean full-bleed artwork rather than a mark on a
  // ground, and there is no colour to extend outwards with.
  const flat = corners.every((c) => c.every((v, i) => Math.abs(v - first[i]!) <= 12));
  if (!flat) return null;

  const channel = (i: number) => Math.round(corners.reduce((s, c) => s + c[i]!, 0) / corners.length);
  return { r: channel(0), g: channel(1), b: channel(2) };
}

/**
 * Compose one icon.
 *
 * The two variants differ in one thing, the shape of the ground:
 *
 * - **maskable** is a full-bleed square. Android applies the launcher's own
 *   shape to it — a circle on one phone, a squircle on another — so drawing a
 *   circle here would show as a circle sitting inside a squircle with a ring of
 *   background between them.
 * - **any** is a circle the icon draws itself, with transparent corners. Nothing
 *   masks it, so if it does not draw a shape it does not have one. This is the
 *   variant that was wrong: it used a 0.9 margin on a transparent background,
 *   which measured on the live site put its furthest content at 127.6% of the
 *   radius — and Chrome's install prompt and several launchers mask it to a
 *   circle anyway, which is what cut the logo.
 */
export async function composeBrandIcon(
  source: Buffer | Uint8Array,
  size: number,
  variant: IconVariant,
): Promise<Buffer> {
  // Imported at the point of use, like everywhere else sharp is touched, so a
  // deployment without it still boots.
  const sharp = (await import("sharp")).default;

  const meta = await sharp(source).metadata();

  /**
   * Whether the uploaded logo is already an icon.
   *
   * This is the whole decision, and getting it wrong is what produced the
   * reported problem: Broadmate's logo is an opaque black square with the mark
   * centred on it — already a tile — and this shrank it to 56.6% and set it on
   * a near-white circle. The result was a small black square floating in a
   * white ring, which is not the logo and not an icon.
   *
   * Opaque and roughly square means somebody has already designed the tile,
   * margins and all, and the honest thing is to use it. A transparent PNG or a
   * wide wordmark has not: it needs a ground to sit on and room around it, or
   * it turns into a dark smudge on a dark launcher.
   */
  const ratio = (meta.width ?? 1) / (meta.height ?? 1);
  const alreadyATile = meta.hasAlpha !== true && ratio > 0.8 && ratio < 1.25;

  if (alreadyATile) {
    const ground = await tileGround(source);

    if (ground === null) {
      /**
       * Full-bleed artwork with no flat ground: used as it is, edge to edge.
       *
       * Four corners that disagree mean there is nothing to extend outwards
       * with, and a stripe of invented colour is worse than letting a launcher
       * take a corner.
       */
      return sharp(source)
        .resize(size, size, { fit: "cover", position: "centre" })
        .flatten({ background: ICON_BACKGROUND })
        .png()
        .toBuffer();
    }

    if (variant === "any") {
      /**
       * A circle this draws itself, in the logo's own colour.
       *
       * Three rounds arrived here. First a near-white circle with the logo
       * shrunk onto it, which was not the logo. Then the tile edge to edge,
       * on the reasoning that nothing masks the plain variant so a square is
       * honest -- and that was wrong twice over: launchers *do* mask it, and
       * the mark sits at 96.7% of the tile's inscribed radius, so whatever
       * cropped it took the ring with the corners. "kata hua lag raha hai."
       *
       * Drawing the shape here is what stops that being somebody else's
       * decision. The corners are transparent, so a launcher that rounds icons
       * has nothing left to round, and one that does not still shows a circle.
       * The ground is the tile's own colour rather than the manifest's, so
       * there is no ring of foreign background around it, and the tile is
       * inset so the mark is never near the rim.
       */
      const inner = Math.round(size * TILE_IN_CIRCLE);
      const pad = Math.round((size - inner) / 2);
      const tile = await sharp(source)
        .resize(inner, inner, { fit: "cover", position: "centre" })
        .toBuffer();

      const circle = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
          `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
      );

      return sharp({
        create: { width: size, height: size, channels: 4, background: { ...ground, alpha: 1 } },
      })
        .composite([
          { input: tile, top: pad, left: pad },
          // The tile is square and the frame is a circle, so its corners fall
          // outside — they are ground, and they are cut by ground of the same
          // colour, which is why this reads as one solid disc.
          { input: circle, blend: "dest-in" },
        ])
        .png()
        .toBuffer();
    }

    /**
     * Maskable, where the launcher keeps only the middle 80%.
     *
     * The tile is scaled into that circle whole and the rest is filled with the
     * tile's **own** corner colour, so the padding is invisible — it reads as
     * the same black square, just with the mark sitting where a mask cannot
     * reach it. This is what "sirf logo" has to mean here: no ring of foreign
     * background, and no shrinking the artwork to a stamp in the middle either.
     */
    const inner = Math.round(size * MASKABLE_SAFE_FRACTION);
    const pad = Math.round((size - inner) / 2);
    const tile = await sharp(source)
      .resize(inner, inner, { fit: "cover", position: "centre" })
      .toBuffer();

    return sharp({
      create: { width: size, height: size, channels: 4, background: { ...ground, alpha: 1 } },
    })
      .composite([{ input: tile, top: pad, left: pad }])
      .png()
      .toBuffer();
  }

  const inner = Math.round(size * ICON_SAFE_FRACTION);
  const pad = Math.round((size - inner) / 2);

  const logo = await sharp(source)
    .resize(inner, inner, { fit: "contain", background: { ...ICON_BACKGROUND, alpha: 0 } })
    .toBuffer();

  const ground =
    variant === "maskable"
      ? sharp({
          create: { width: size, height: size, channels: 4, background: ICON_BACKGROUND },
        })
      : sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
              `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" ` +
              `fill="rgb(${ICON_BACKGROUND.r},${ICON_BACKGROUND.g},${ICON_BACKGROUND.b})"/></svg>`,
          ),
        );

  return ground.composite([{ input: logo, top: pad, left: pad }]).png().toBuffer();
}
