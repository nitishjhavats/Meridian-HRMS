import crypto from "node:crypto";
import { ValidationError } from "../errors";

/**
 * Passphrase encryption for a whole export archive.
 *
 * The field encryption in `lib/crypto/field.ts` uses one platform key, which is
 * right for data the app has to read back on its own. An export is different:
 * it leaves the server, so it is locked with a passphrase that only the person
 * who asked for it holds. A copy of the file, on its own, is unreadable.
 *
 * scrypt turns the passphrase into a key. It is deliberately slow and memory
 * hard, so guessing at the file offline stays expensive.
 *
 * Layout: "HRMSX1" | salt(16) | iv(12) | tag(16) | ciphertext
 */

const MAGIC = Buffer.from("HRMSX1", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;

/**
 * scrypt cost. N=16384 is roughly 100 ms and 16 MB here — enough to make
 * guessing painful, low enough that a request does not stall on it. `maxmem`
 * has to be raised explicitly because Node's 32 MB default sits right on the
 * boundary and would throw for a larger N.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, 32, SCRYPT);
}

export function encryptArchive(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}

/**
 * Unlocks an archive.
 *
 * A wrong passphrase and a tampered file are indistinguishable here — GCM fails
 * the same way for both — so they get the same message. There is nothing useful
 * to tell apart: either way the bytes cannot be trusted.
 */
export function decryptArchive(payload: Buffer, passphrase: string): Buffer {
  if (payload.length < HEADER || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ValidationError("That file is not an export archive.");
  }

  let cursor = MAGIC.length;
  const salt = payload.subarray(cursor, (cursor += SALT_BYTES));
  const iv = payload.subarray(cursor, (cursor += IV_BYTES));
  const tag = payload.subarray(cursor, (cursor += TAG_BYTES));
  const data = payload.subarray(cursor);

  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new ValidationError("That password did not unlock the archive.");
  }
}

/**
 * A passphrase people can actually retype.
 *
 * Five groups of four from an alphabet with no character that can be misread —
 * no O against 0, no I against 1 — because this gets copied by hand at least as
 * often as it gets pasted.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassphrase(groups = 5, size = 4): string {
  const bytes = crypto.randomBytes(groups * size);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return Array.from({ length: groups }, (_, g) =>
    chars.slice(g * size, g * size + size).join(""),
  ).join("-");
}
