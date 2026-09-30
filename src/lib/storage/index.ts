import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "../errors";
import {
  type FileKind,
  type StorageAdapter,
  type StoredFile,
  assertSafeKey,
  buildKey,
} from "./keys";
import { supabaseStorageFromEnv } from "./supabase";
import {
  COMPRESSION,
  type CompressionProfile,
  type CompressionProfileName,
  compressImage,
  isCompressibleImage,
} from "./compress";

export * from "./compress";
export * from "./keys";

/**
 * File storage behind an adapter.
 *
 * Three drivers ship. `database` keeps compressed bytes in Postgres, which is
 * the right default on a laptop or a host with an ephemeral disk — one backup
 * covers the data and its files. `supabase` puts the bytes in a private bucket
 * and keeps the `FileObject` row as an index, which is what production uses.
 * `local` writes to disk. Nothing outside this folder knows which is in use.
 *
 * Keys are opaque and tenant-prefixed (`org/<orgId>/<kind>/<random>.<ext>`), so a
 * key cannot be guessed from an employee id, and every read still goes through an
 * authorised route rather than a public URL.
 */

// ------------------------------------------------------------------ validation

export interface UploadConstraints {
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  allowedExtensions: readonly string[];
}

export const DOCUMENT_CONSTRAINTS: UploadConstraints = {
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"],
  allowedExtensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic"],
};

export const IMAGE_CONSTRAINTS: UploadConstraints = {
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"],
  allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".heic"],
};

/** Magic-number prefixes, so a renamed `.exe` cannot masquerade as a PDF. */
const SIGNATURES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  // HEIC/HEIF: the `ftyp` box at offset 4, with a HEIF-family brand.
  { mime: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], offset: 4 },
  { mime: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31], offset: 4 },
];

export function sniffMimeType(data: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (data.length < offset + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => data[offset + i] === b)) return sig.mime;
  }
  return null;
}

export function validateUpload(
  data: Buffer,
  declaredMime: string,
  fileName: string,
  constraints: UploadConstraints = DOCUMENT_CONSTRAINTS,
): { mimeType: string; extension: string } {
  if (data.length === 0) throw new ValidationError("That file is empty.");
  if (data.length > constraints.maxBytes) {
    throw new ValidationError(
      `That file is ${(data.length / 1024 / 1024).toFixed(1)} MB. The limit is ${constraints.maxBytes / 1024 / 1024} MB.`,
    );
  }

  const extension = path.extname(fileName).toLowerCase();
  if (!constraints.allowedExtensions.includes(extension)) {
    throw new ValidationError(
      `Files of type ${extension || "(none)"} are not accepted. Allowed: ${constraints.allowedExtensions.join(", ")}.`,
    );
  }

  // A file whose bytes match no known signature is refused outright. Trusting
  // the declared type would let anything through simply by being named `.jpg`.
  const sniffed = sniffMimeType(data);
  if (!sniffed) {
    throw new ValidationError("That file is not a readable image or PDF. Re-export it and try again.");
  }
  if (!constraints.allowedMimeTypes.includes(sniffed)) {
    throw new ValidationError("That file type is not accepted.");
  }
  if (declaredMime !== sniffed && !declaredMime.startsWith("application/octet-stream")) {
    throw new ValidationError("That file's contents do not match its type. Re-export it and try again.");
  }

  return { mimeType: sniffed, extension };
}

// ------------------------------------------------------------------ ingest

/** Which compression profile a kind of file gets. */
const PROFILE_BY_KIND: Partial<Record<FileKind, CompressionProfileName>> = {
  selfies: "selfie",
  avatars: "reference",
  logos: "logo",
  signatures: "signature",
  // A seal wants what a signature wants: modest, and PNG so a round stamp keeps
  // its transparent corners. The JPEG profiles flatten onto white, which would
  // print a square box around it.
  stamps: "signature",
  documents: "document",
  bills: "document",
  attachments: "document",
};

export interface IngestResult extends StoredFile {
  originalBytes: number;
  /** True when the bytes were re-encoded rather than stored as uploaded. */
  compressed: boolean;
}

/**
 * The single entry point for accepting an upload: validate, compress, store.
 *
 * Services call this rather than `storage().put` so that no path exists by which
 * an uncompressed, EXIF-bearing original reaches storage.
 */
export async function ingestUpload(
  file: { data: Buffer; fileName: string; mimeType: string },
  options: {
    organizationId: string | null;
    kind: FileKind;
    constraints?: UploadConstraints;
    /** Overrides the profile chosen from `kind`. */
    profile?: CompressionProfile;
  },
): Promise<IngestResult> {
  const constraints =
    options.constraints ?? (options.kind === "documents" ? DOCUMENT_CONSTRAINTS : IMAGE_CONSTRAINTS);

  const { mimeType, extension } = validateUpload(
    file.data,
    file.mimeType,
    file.fileName,
    constraints,
  );

  const profileName = PROFILE_BY_KIND[options.kind];
  const profile = options.profile ?? (profileName ? COMPRESSION[profileName] : undefined);

  // PDFs pass through untouched; re-encoding a document would destroy its text.
  if (!profile || !isCompressibleImage(mimeType)) {
    const key = buildKey(options.organizationId, options.kind, extension);
    const stored = await storage().put(key, file.data, mimeType, {
      organizationId: options.organizationId,
      kind: options.kind,
    });
    return { ...stored, originalBytes: file.data.length, compressed: false };
  }

  const compressed = await compressImage(file.data, profile);
  const key = buildKey(options.organizationId, options.kind, compressed.extension);
  const stored = await storage().put(key, compressed.data, compressed.mimeType, {
    organizationId: options.organizationId,
    kind: options.kind,
  });

  return { ...stored, originalBytes: file.data.length, compressed: true };
}

// ------------------------------------------------------------------ drivers

/** Keeps compressed bytes in Postgres. The default. */
export class DatabaseStorage implements StorageAdapter {
  async put(
    key: string,
    data: Buffer,
    mimeType: string,
    meta: { organizationId?: string | null; kind?: string } = {},
  ): Promise<StoredFile> {
    assertSafeKey(key);
    const { prisma } = await import("../db/prisma");
    const checksum = createHash("sha256").update(data).digest("hex");

    // Prisma's Bytes maps to Uint8Array; Node's Buffer carries a wider
    // ArrayBufferLike, so copy into a plain view at the boundary.
    const bytes = Uint8Array.from(data);

    await prisma.fileObject.upsert({
      where: { key },
      create: {
        key,
        organizationId: meta.organizationId ?? null,
        kind: meta.kind ?? key.split("/").at(-2) ?? "other",
        mimeType,
        sizeBytes: data.length,
        checksum,
        data: bytes,
      },
      update: { mimeType, sizeBytes: data.length, checksum, data: bytes },
    });

    return { key, size: data.length, mimeType, checksum };
  }

  async get(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
    assertSafeKey(key);
    const { prisma } = await import("../db/prisma");
    const row = await prisma.fileObject.findUnique({
      where: { key },
      select: { data: true, mimeType: true },
    });
    // A row with no bytes belongs to another driver — this table doubles as the
    // metadata index for Supabase Storage. Treat it as absent rather than
    // returning an empty file.
    return row?.data ? { data: Buffer.from(row.data), mimeType: row.mimeType } : null;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { prisma } = await import("../db/prisma");
    await prisma.fileObject.deleteMany({ where: { key } });
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const { prisma } = await import("../db/prisma");
    const row = await prisma.fileObject.findUnique({ where: { key }, select: { id: true } });
    return row != null;
  }
}

export class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    // Defence in depth: even with a validated key, refuse anything that escapes.
    if (!full.startsWith(path.resolve(this.root))) {
      throw new ValidationError("That file reference is not valid.");
    }
    return full;
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<StoredFile> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    await writeFile(`${full}.meta`, JSON.stringify({ mimeType }), "utf8");

    return {
      key,
      size: data.length,
      mimeType,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  }

  async get(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const full = this.resolve(key);
      const data = await readFile(full);
      let mimeType = "application/octet-stream";
      try {
        const meta = JSON.parse(await readFile(`${full}.meta`, "utf8")) as { mimeType?: string };
        if (meta.mimeType) mimeType = meta.mimeType;
      } catch {
        // Missing sidecar is not fatal; fall back to a generic type.
      }
      return { data, mimeType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await rm(full, { force: true });
    await rm(`${full}.meta`, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (adapter) return adapter;

  const driver = process.env.STORAGE_DRIVER ?? "database";
  if (driver === "local") {
    adapter = new LocalDiskStorage(path.resolve(process.env.STORAGE_LOCAL_DIR ?? "./storage"));
  } else if (driver === "database") {
    adapter = new DatabaseStorage();
  } else if (driver === "supabase") {
    // Required lazily: the module reads its configuration on construction, and
    // nothing should fail at import time in a deployment using another driver.
    adapter = supabaseStorageFromEnv();
  } else {
    throw new Error(
      `STORAGE_DRIVER "${driver}" is not implemented. Use "database", "supabase" or "local", or add its adapter in src/lib/storage.`,
    );
  }
  return adapter;
}

/** Exposed for tests. */
export function setStorageAdapter(next: StorageAdapter | null): void {
  adapter = next;
}
