import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  COMPRESSION,
  DOCUMENT_CONSTRAINTS,
  IMAGE_CONSTRAINTS,
  assertSafeKey,
  buildKey,
  compressImage,
  describeSaving,
  isCompressibleImage,
  keyBelongsTo,
  sniffMimeType,
  validateUpload,
} from "./index";
import { ValidationError } from "../errors";

/** A JPEG large enough that compression has something to do. */
async function makeJpeg(width = 3000, height = 3000): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 90, b: 200 } },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
}

async function makePng(width = 800, height = 800): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

describe("upload validation", () => {
  it("identifies real files by their magic bytes", async () => {
    expect(sniffMimeType(await makeJpeg(32, 32))).toBe("image/jpeg");
    expect(sniffMimeType(await makePng(32, 32))).toBe("image/png");
    expect(sniffMimeType(Buffer.from("%PDF-1.7\n..."))).toBe("application/pdf");
  });

  it("accepts a genuine image", async () => {
    const jpeg = await makeJpeg(64, 64);
    expect(validateUpload(jpeg, "image/jpeg", "selfie.jpg", IMAGE_CONSTRAINTS)).toEqual({
      mimeType: "image/jpeg",
      extension: ".jpg",
    });
  });

  // The gap that let a renamed file through before: an allowed extension plus an
  // allowed declared type, but bytes that are not an image at all.
  it("refuses a file whose bytes are not a real image", () => {
    const notAnImage = Buffer.alloc(4096, 0x41);
    expect(() => validateUpload(notAnImage, "image/jpeg", "payload.jpg", IMAGE_CONSTRAINTS)).toThrow(
      ValidationError,
    );
  });

  it("refuses a PDF renamed as a photo", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
    expect(() => validateUpload(pdf, "image/jpeg", "sneaky.jpg", IMAGE_CONSTRAINTS)).toThrow(
      ValidationError,
    );
  });

  it("refuses an extension the constraints do not allow", async () => {
    const jpeg = await makeJpeg(32, 32);
    expect(() => validateUpload(jpeg, "image/jpeg", "photo.exe", IMAGE_CONSTRAINTS)).toThrow(
      /not accepted/,
    );
  });

  it("refuses an empty file", () => {
    expect(() => validateUpload(Buffer.alloc(0), "image/jpeg", "x.jpg")).toThrow(/empty/);
  });

  it("refuses a file over the size limit", () => {
    const huge = Buffer.alloc(IMAGE_CONSTRAINTS.maxBytes + 1, 0xff);
    huge[0] = 0xff;
    huge[1] = 0xd8;
    huge[2] = 0xff;
    expect(() => validateUpload(huge, "image/jpeg", "big.jpg", IMAGE_CONSTRAINTS)).toThrow(/limit/);
  });

  it("still accepts PDFs where documents are allowed", () => {
    const pdf = Buffer.from("%PDF-1.7\ncontent");
    expect(validateUpload(pdf, "application/pdf", "aadhaar.pdf", DOCUMENT_CONSTRAINTS).mimeType).toBe(
      "application/pdf",
    );
  });
});

describe("image compression", () => {
  it("shrinks an oversized photo substantially", async () => {
    const original = await makeJpeg(3000, 3000);
    const result = await compressImage(original, COMPRESSION.selfie);

    expect(result.compressedBytes).toBeLessThan(original.length);
    expect(result.width).toBeLessThanOrEqual(COMPRESSION.selfie.maxDimension);
    expect(result.height).toBeLessThanOrEqual(COMPRESSION.selfie.maxDimension);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.extension).toBe(".jpg");
  });

  it("keeps reference photos larger than selfies", async () => {
    const original = await makeJpeg(2000, 2000);
    const selfie = await compressImage(original, COMPRESSION.selfie);
    const reference = await compressImage(original, COMPRESSION.reference);
    expect(reference.width).toBeGreaterThan(selfie.width);
  });

  // A small avatar must not be blown up to the profile's max and end up bigger.
  it("never enlarges an image that is already small", async () => {
    const small = await makeJpeg(200, 200);
    const result = await compressImage(small, COMPRESSION.reference);
    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
  });

  it("preserves transparency for logos by staying PNG", async () => {
    const logo = await makePng(1000, 1000);
    const result = await compressImage(logo, COMPRESSION.logo);
    expect(result.mimeType).toBe("image/png");
    expect(result.extension).toBe(".png");
  });

  // Re-encoding is what removes the GPS block phones embed in photos.
  it("strips EXIF metadata", async () => {
    const withExif = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#336699" },
    })
      .withExif({ IFD0: { Copyright: "test", Software: "camera" } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await compressImage(withExif, COMPRESSION.selfie);
    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  });

  it("refuses bytes that are not an image", async () => {
    await expect(compressImage(Buffer.alloc(1024, 0x41), COMPRESSION.selfie)).rejects.toThrow(
      ValidationError,
    );
  });

  it("describes the saving in human terms", async () => {
    const original = await makeJpeg(2400, 2400);
    const result = await compressImage(original, COMPRESSION.selfie);
    expect(describeSaving(result)).toMatch(/KB/);
  });

  it("knows which types are worth compressing", () => {
    expect(isCompressibleImage("image/jpeg")).toBe(true);
    expect(isCompressibleImage("image/heic")).toBe(true);
    expect(isCompressibleImage("application/pdf")).toBe(false);
  });
});

describe("storage keys", () => {
  it("scopes a key to its organisation", () => {
    const key = buildKey("org_123", "selfies", ".jpg");
    expect(key).toMatch(/^org\/org_123\/selfies\/[A-Za-z0-9_-]+\.jpg$/);
  });

  it("puts platform files outside any tenant", () => {
    expect(buildKey(null, "exports", ".csv")).toMatch(/^platform\/exports\//);
  });

  // Cross-tenant reads are the thing this prevents.
  it("refuses a key belonging to another organisation", () => {
    const key = buildKey("org_a", "documents", ".pdf");
    expect(keyBelongsTo(key, "org_a")).toBe(true);
    expect(keyBelongsTo(key, "org_b")).toBe(false);
    // The platform owner may read anything.
    expect(keyBelongsTo(key, null)).toBe(true);
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => assertSafeKey("../../etc/passwd")).toThrow(ValidationError);
    expect(() => assertSafeKey("/etc/passwd")).toThrow(ValidationError);
    expect(() => assertSafeKey("C:\\Windows\\System32")).toThrow(ValidationError);
    expect(() => assertSafeKey("")).toThrow(ValidationError);
  });
});
