import { describe, expect, it } from "vitest";

import {
  ICON_BACKGROUND,
  ICON_SAFE_FRACTION,
  MASKABLE_SAFE_FRACTION,
  TILE_IN_CIRCLE,
  composeBrandIcon,
} from "./icon";

/**
 * Two reports, five months apart, pulling in opposite directions — and both
 * right, because they were about different logos.
 *
 * The first: "pwa install karne par ka logo circle me hona chahiye … uske andar
 * bina kate." The plain variant was measured on the live site at **127.6%** of
 * the radius on a transparent background, so a circular launcher mask cut it.
 * Fixed by laying the artwork inside a safe square on a drawn ground.
 *
 * The second: "pwa k icon me sirf logo ka istemal karna … jaise abhi use ho
 * raha." That fix had been applied to a logo that did not need it. Broadmate's
 * logo is an opaque black square with a blue ring mark on it — already a
 * designed tile — and shrinking it to 56.6% on a near-white circle produced a
 * small black square floating in a white ring. Not the logo, and not an icon.
 *
 * So the code now decides which kind of source it has, and these are the
 * measurements that hold each branch honest. They are measurements rather than
 * shape assertions on purpose: measuring the rendered pixels is what found the
 * original 127.6%, when every number in the source read correctly.
 */

/**
 * A logo that is already an icon: a mark on its own flat ground, opaque.
 *
 * Shaped like the real one. Measured from the uploaded Broadmate logo, its ring
 * reaches **96.7%** of the inscribed radius on a black square — which is why
 * "shrink it and put it on a white circle" ruined it, and why the maskable
 * variant still needs handling.
 */
async function designedTile(size: number, markRadius = 0.96): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const r = Math.round((size / 2) * markRadius) - 9;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<rect width="${size}" height="${size}" fill="#000000"/>` +
        `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" ` +
        `stroke="#22a7f0" stroke-width="18"/></svg>`,
    ),
  )
    // No alpha channel: that, plus a square ratio, is what marks a source as
    // already designed. A PNG that merely happens to be fully opaque still
    // carries the channel, so the fixture has to flatten it the way an export
    // from a design tool would.
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .png()
    .toBuffer();
}

/** A logo that is not: a bare mark with nothing behind it. */
async function transparentMark(size: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 4}" fill="#0a14c8"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The furthest artwork pixel from the centre, as a fraction of the radius.
 *
 * `ground` is whatever this icon's background is meant to be — the near-white
 * the composer draws, or the tile's own colour. Neither counts as artwork, and
 * neither does transparency.
 */
async function furthestContent(png: Buffer, ground: Rgb): Promise<number> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const cx = w / 2;
  const cy = h / 2;
  let furthest = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      // Fully opaque only. A drawn circle has an anti-aliased rim whose pixels
      // are part background and part nothing; counting those measured the edge
      // of the frame rather than the edge of the artwork.
      if (data[i + 3]! < 250) continue;
      const isGround =
        Math.abs(data[i]! - ground.r) < 10 &&
        Math.abs(data[i + 1]! - ground.g) < 10 &&
        Math.abs(data[i + 2]! - ground.b) < 10;
      if (isGround) continue;
      furthest = Math.max(furthest, Math.hypot(x - cx, y - cy));
    }
  }
  return furthest / (w / 2);
}

async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const GROUND: Rgb = { r: ICON_BACKGROUND.r, g: ICON_BACKGROUND.g, b: ICON_BACKGROUND.b };

describe("a logo that is already a tile is used as the logo", () => {
  it("keeps the mark nearly its own size, not stamped on a white circle", async () => {
    /**
     * Two numbers, and the distance between them is the whole design.
     *
     * Under the first rule every source went through a 56.6% safe square, so
     * this mark measured about 0.54 of the radius inside a white ring. It is
     * now near the rim, which is what a designed icon looks like.
     *
     * The upper bound is the second report. Edge to edge put the mark at 0.967
     * -- four pixels from the edge at 512 -- and every launcher that insets an
     * icon slightly, or antialiases its own rim, shaved the ring: "kata hua lag
     * raha hai". A designed icon leaves itself margin; so does this.
     */
    const furthest = await furthestContent(
      await composeBrandIcon(await designedTile(512), 512, "any"),
      BLACK,
    );
    // The measured value travels with the failure. This asserted a bare bound
    // and failed once in a full-suite run and never again on its own, which is
    // undiagnosable without the number that was actually produced.
    expect(furthest, `measured ${furthest}`).toBeGreaterThan(0.8);
    expect(furthest, `measured ${furthest}`).toBeLessThan(0.92);
  });

  it("is a circle it drew itself, with transparent corners", async () => {
    /**
     * Drawn here rather than left to the launcher, which is the fix.
     *
     * The plain variant was a full-bleed square on the reasoning that nothing
     * masks it. Launchers do mask it, they disagree about how, and the mark was
     * close enough to the edge that whichever way they cropped it took the ring
     * with the corners. A shape this icon owns cannot be cropped wrongly by
     * somebody else: a launcher that rounds icons has nothing left to round,
     * and one that does not still shows a circle.
     */
    const png = await composeBrandIcon(await designedTile(512), 512, "any");
    expect((await pixel(png, 2, 2))[3]).toBe(0);
    expect((await pixel(png, 509, 2))[3]).toBe(0);
    expect((await pixel(png, 2, 509))[3]).toBe(0);
    expect((await pixel(png, 509, 509))[3]).toBe(0);
    // Opaque through the middle, or it is a hole rather than a disc.
    expect((await pixel(png, 256, 256))[3]).toBe(255);
  });

  it("and the circle is the tile's own colour, so there is no white ring", async () => {
    // Just inside the rim, where the drawn ground shows. Filling it with the
    // manifest's near-white would put back the ring these two rounds removed.
    const png = await composeBrandIcon(await designedTile(512), 512, "any");
    expect((await pixel(png, 256, 6)).slice(0, 3)).toEqual([0, 0, 0]);
    expect((await pixel(png, 6, 256)).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("survives a launcher that insets the icon before it masks it", async () => {
    /**
     * The reported failure, reproduced.
     *
     * Some launchers shrink an icon a few percent and then apply their shape.
     * Against an edge-to-edge tile that clips the mark; against a circle with
     * margin it takes ground. Measured on the result rather than reasoned
     * about, because reasoning about it is what produced the bug.
     */
    const sharp = (await import("sharp")).default;
    const png = await composeBrandIcon(await designedTile(512), 512, "any");

    const inset = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: await sharp(png).resize(470, 470).toBuffer(), top: 21, left: 21 }])
      .png()
      .toBuffer();

    const masked = await sharp(inset)
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
              `<circle cx="256" cy="256" r="256" fill="#fff"/></svg>`,
          ),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();

    // Unchanged: every artwork pixel that was there before the launcher had its
    // way is still there afterwards.
    const before = await furthestContent(png, BLACK);
    const after = await furthestContent(masked, BLACK);
    expect(after).toBeCloseTo(before * (470 / 512), 2);
  });

  it("maskable scales the whole tile into the safe circle rather than cropping it", async () => {
    // Android keeps only the middle 80% of a maskable icon. A ring at 96% of
    // the tile's radius would lose its edges; scaled with the tile it lands at
    // 0.96 × 0.8 ≈ 0.77 and survives.
    const png = await composeBrandIcon(await designedTile(512), 512, "maskable");
    const furthest = await furthestContent(png, BLACK);
    expect(furthest).toBeLessThanOrEqual(0.81);
    expect(furthest).toBeGreaterThan(0.7);
  });

  it("pads the maskable variant with the tile's own colour, not the manifest's", async () => {
    // The padding has to be invisible. Filling it with the near-white ground
    // would put back the ring this change exists to remove.
    const png = await composeBrandIcon(await designedTile(512), 512, "maskable");
    expect((await pixel(png, 2, 2)).slice(0, 3)).toEqual([0, 0, 0]);
    expect((await pixel(png, 509, 509)).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("full-bleed artwork with no flat ground is left edge to edge in both variants", async () => {
    // Four corners that disagree mean there is no colour to extend outwards
    // with, and inventing one is worse than letting the mask take a corner.
    const sharp = (await import("sharp")).default;
    const quilt = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
          `<rect width="256" height="256" fill="#ff0000"/>` +
          `<rect x="256" width="256" height="256" fill="#00ff00"/>` +
          `<rect y="256" width="256" height="256" fill="#0000ff"/>` +
          `<rect x="256" y="256" width="256" height="256" fill="#ffff00"/></svg>`,
      ),
    )
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();

    for (const variant of ["any", "maskable"] as const) {
      const png = await composeBrandIcon(quilt, 512, variant);
      expect((await pixel(png, 2, 2)).slice(0, 3), variant).toEqual([255, 0, 0]);
      expect((await pixel(png, 509, 509)).slice(0, 3), variant).toEqual([255, 255, 0]);
    }
  });
});

describe("a logo that is not a tile still gets a ground and a margin", () => {
  it("a bare transparent mark survives a circular mask, plain variant", async () => {
    const png = await composeBrandIcon(await transparentMark(512), 512, "any");
    // The safe zone is a circle of 80% diameter, so 80% of the radius.
    expect(await furthestContent(png, GROUND)).toBeLessThanOrEqual(0.81);
  });

  it("and maskable, which is the one Android actually crops", async () => {
    const png = await composeBrandIcon(await transparentMark(512), 512, "maskable");
    expect(await furthestContent(png, GROUND)).toBeLessThanOrEqual(0.81);
  });

  it("the plain variant is a circle — transparent at the corners", async () => {
    const png = await composeBrandIcon(await transparentMark(512), 512, "any");
    expect((await pixel(png, 2, 2))[3]).toBe(0);
    expect((await pixel(png, 509, 2))[3]).toBe(0);
    expect((await pixel(png, 2, 509))[3]).toBe(0);
    // …and opaque through the middle, or it is a hole rather than a circle.
    expect((await pixel(png, 256, 256))[3]).toBe(255);
  });

  it("the maskable variant is full-bleed, so a squircle launcher has ground to keep", async () => {
    const png = await composeBrandIcon(await transparentMark(512), 512, "maskable");
    expect((await pixel(png, 0, 0))[3]).toBe(255);
    expect((await pixel(png, 511, 0))[3]).toBe(255);
  });

  it("a wide wordmark is never taller than the safe square", async () => {
    // Wide and opaque, so the ratio test — not the alpha test — is what has to
    // keep it out of the tile branch. `contain` makes it short, so it sits
    // comfortably inside; pinned so a later switch to `cover` is caught, since
    // that would crop exactly what the first report asked to stop being cropped.
    const sharp = (await import("sharp")).default;
    const wide = await sharp({
      create: { width: 1200, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();
    const png = await composeBrandIcon(wide, 512, "any");
    expect(await furthestContent(png, GROUND)).toBeLessThanOrEqual(0.81);
  });
});

describe("the frame itself", () => {
  it("renders at every size the manifest declares", async () => {
    const sharp = (await import("sharp")).default;
    const tile = await designedTile(512);
    for (const size of [192, 256, 384, 512]) {
      for (const variant of ["any", "maskable"] as const) {
        const meta = await sharp(await composeBrandIcon(tile, size, variant)).metadata();
        expect([meta.width, meta.height], `${size} ${variant}`).toEqual([size, size]);
      }
    }
  });

  it("states the safe fraction as the largest square inside an 80% circle", () => {
    expect(ICON_SAFE_FRACTION).toBeCloseTo(0.8 / Math.SQRT2, 2);
  });

  it("and the maskable fraction as the 80% the launcher promises to keep", () => {
    expect(MASKABLE_SAFE_FRACTION).toBe(0.8);
  });
});

describe("the fraction the tile fills, stated once", () => {
  it("leaves the mark room and does not shrink it to a stamp", () => {
    /**
     * Both failures this number sits between, in one assertion.
     *
     * Too high and the mark touches the rim, which is what got it shaved.
     * Too low and it becomes a small logo floating in a disc, which is the
     * complaint from the round before that.
     */
    expect(TILE_IN_CIRCLE).toBeGreaterThan(0.8);
    expect(TILE_IN_CIRCLE).toBeLessThan(0.95);
  });

  it("is wider than the maskable inset, because nothing crops this one", () => {
    // The maskable variant hands its corners to a launcher and has to sit
    // inside the 80% Android guarantees. The plain variant owns its own shape,
    // so it can use more of the frame.
    expect(TILE_IN_CIRCLE).toBeGreaterThan(MASKABLE_SAFE_FRACTION);
  });
});
