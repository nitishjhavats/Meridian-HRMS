import { ValidationError } from "../errors";
import { randomToken } from "../crypto/field";

/**
 * The storage contract and the shape of a key.
 *
 * Separate from `index.ts` so that a driver can implement the interface without
 * importing the module that chooses between drivers. `index.ts` re-exports
 * everything here, so nothing outside this folder needs to know it moved.
 */

export interface StoredFile {
  key: string;
  size: number;
  mimeType: string;
  checksum: string;
}

export interface StorageAdapter {
  put(
    key: string,
    data: Buffer,
    mimeType: string,
    meta?: { organizationId?: string | null; kind?: string },
  ): Promise<StoredFile>;
  get(key: string): Promise<{ data: Buffer; mimeType: string } | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export type FileKind =
  | "documents"
  | "selfies"
  | "avatars"
  | "logos"
  | "signatures"
  | "stamps"
  | "letters"
  | "slips"
  | "attachments"
  | "bills"
  | "exports";

export function buildKey(
  organizationId: string | null,
  kind: FileKind,
  extension: string,
): string {
  const scope = organizationId ? `org/${organizationId}` : "platform";
  return `${scope}/${kind}/${randomToken(16)}${extension}`;
}

/** A key must stay inside the storage root — no traversal, no absolute paths. */
export function assertSafeKey(key: string): void {
  if (
    !key ||
    key.includes("..") ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /^[a-zA-Z]:/.test(key)
  ) {
    throw new ValidationError("That file reference is not valid.");
  }
}

/** Confirms a key belongs to the caller's tenant before it is ever read. */
export function keyBelongsTo(key: string, organizationId: string | null): boolean {
  assertSafeKey(key);
  if (organizationId === null) return true; // platform-level access
  return key.startsWith(`org/${organizationId}/`);
}
