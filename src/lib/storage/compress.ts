import { ValidationError } from "../errors";

/**
 * Image compression.
 *
 * Every image entering storage is re-encoded before it is written. A phone
 * camera hands over 3–6 MB per selfie; at two punches a day that is roughly
 * 2.5 GB per employee per year, which is a storage bill and a backup problem
 * for a picture nobody will ever look at closely.
 *
 * Re-encoding also **strips EXIF**, which quietly removes the GPS coordinates,
 * device serial and original timestamp that phones embed in photos. Attendance
 * already records location deliberately and with consent; carrying a second,
 * invisible copy inside the image is not something anyone agreed to.
 */

export interface CompressionProfile {
  /** Longest edge in pixels; larger images are scaled down. */
  maxDimension: number;
  /** JPEG/WebP quality, 1–100. */
  quality: number;
  /** Output format. PNG is kept for logos so transparency survives. */
  format: "jpeg" | "png" | "webp";
}

export const COMPRESSION = {
  /** Attendance selfies: only ever viewed small, and purged after 60 days. */
  selfie: { maxDimension: 800, quality: 78, format: "jpeg" },
  /**
   * Face reference photos: kept larger and cleaner than a selfie, because every
   * future match is compared against this one image.
   */
  reference: { maxDimension: 1024, quality: 90, format: "jpeg" },
  avatar: { maxDimension: 512, quality: 82, format: "jpeg" },
  logo: { maxDimension: 512, quality: 92, format: "png" },
  /** Scanned documents stay readable — an unreadable PAN card is useless. */
  document: { maxDimension: 2000, quality: 85, format: "jpeg" },
  signature: { maxDimension: 600, quality: 92, format: "png" },
} as const satisfies Record<string, CompressionProfile>;

export type CompressionProfileName = keyof typeof COMPRESSION;

export interface CompressionResult {
  data: Buffer;
  mimeType: string;
  extension: string;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
}

const MIME_BY_FORMAT = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

const EXTENSION_BY_FORMAT = { jpeg: ".jpg", png: ".png", webp: ".webp" } as const;

export function isCompressibleImage(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType);
}

/**
 * Re-encodes an image to the given profile.
 *
 * `withoutEnlargement` matters: a 200×200 avatar must not be upscaled to 512 and
 * end up *bigger* than it started.
 */
export async function compressImage(
  input: Buffer,
  profile: CompressionProfile,
): Promise<CompressionResult> {
  const sharp = (await import("sharp")).default;

  let pipeline = sharp(input, { failOn: "error" })
    .rotate() // Honour the EXIF orientation flag before we discard the metadata.
    .resize({
      width: profile.maxDimension,
      height: profile.maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (profile.format === "jpeg") {
    pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({
      quality: profile.quality,
      mozjpeg: true,
      progressive: true,
    });
  } else if (profile.format === "png") {
    pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  } else {
    pipeline = pipeline.webp({ quality: profile.quality });
  }

  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      data,
      mimeType: MIME_BY_FORMAT[profile.format],
      extension: EXTENSION_BY_FORMAT[profile.format],
      originalBytes: input.length,
      compressedBytes: data.length,
      width: info.width,
      height: info.height,
    };
  } catch {
    // sharp refuses anything that is not really an image, which is a second
    // line of defence behind the magic-number check in `validateUpload`.
    throw new ValidationError("That image could not be read. Re-export it and try again.");
  }
}

/** Human-readable saving, for logs and the upload confirmation. */
export function describeSaving(result: CompressionResult): string {
  const saved = result.originalBytes - result.compressedBytes;
  if (saved <= 0) return `${(result.compressedBytes / 1024).toFixed(0)} KB`;
  const percent = Math.round((saved / result.originalBytes) * 100);
  return `${(result.compressedBytes / 1024).toFixed(0)} KB (${percent}% smaller)`;
}
