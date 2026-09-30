import crypto from "node:crypto";

/**
 * Field-level encryption for data that must be readable by the app but must not
 * sit in the database in the clear: PAN, Aadhaar, bank details, an organisation's
 * OpenRouter key, TOTP secrets, and superadmin-issued payment codes.
 *
 * AES-256-GCM, random IV per value, authentication tag stored alongside. The key
 * comes from `PLATFORM_ENCRYPTION_KEY` and never leaves the server.
 *
 * This is not a substitute for hashing. Passwords and OTPs that only need to be
 * *verified* are hashed with bcrypt instead — see `lib/auth/password.ts`.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

export class CryptoConfigError extends Error {}

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!raw) {
    throw new CryptoConfigError(
      "PLATFORM_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }

  const buffer = Buffer.from(raw, "base64url");
  if (buffer.length !== 32) {
    throw new CryptoConfigError(
      `PLATFORM_ENCRYPTION_KEY must decode to 32 bytes, got ${buffer.length}. Regenerate it.`,
    );
  }

  cachedKey = buffer;
  return buffer;
}

/** Exposed for tests that swap the key. */
export function resetKeyCache(): void {
  cachedKey = null;
}

/** Encrypts a value into `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(
    ".",
  );
}

/** Decrypts a value produced by `encryptField`. Throws if it was tampered with. */
export function decryptField(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CryptoConfigError("Encrypted value is malformed or uses an unsupported version.");
  }

  const iv = Buffer.from(parts[1] as string, "base64url");
  const tag = Buffer.from(parts[2] as string, "base64url");
  const data = Buffer.from(parts[3] as string, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoConfigError("Encrypted value has an unexpected shape.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return encryptField(value);
}

export function decryptOptional(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  try {
    return decryptField(value);
  } catch {
    // A value that will not decrypt (rotated key, corrupted row) must not crash a
    // profile page; the caller renders it as unavailable.
    return null;
  }
}

/**
 * Masks a sensitive identifier for display: `ABCDE1234F` → `••••••234F`.
 * Only the decrypted value should ever be masked — never the ciphertext.
 */
export function maskTail(value: string | null | undefined, visible = 4): string {
  if (!value) return "—";
  if (value.length <= visible) return "•".repeat(value.length);
  return "•".repeat(value.length - visible) + value.slice(-visible);
}

/** Constant-time comparison for short secrets such as confirmation codes. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Cryptographically random numeric code, e.g. a 6-digit payment confirmation code. */
export function randomNumericCode(digits = 6): string {
  const max = 10 ** digits;
  let value: number;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= Math.floor(0xffffffff / max) * max); // reject modulo bias
  return String(value % max).padStart(digits, "0");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
