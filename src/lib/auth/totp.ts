import crypto from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * Written against the spec rather than pulled from a library: the whole
 * algorithm is HMAC-SHA1 plus a truncation, Node already has both, and a
 * dependency in the authentication path is a dependency you have to trust
 * forever.
 *
 * The defaults are the ones every authenticator app assumes — SHA-1, 6 digits,
 * a 30-second step. They are not modern cryptography and they do not need to be:
 * the secret never travels, and a code is valid for well under a minute.
 */

export interface TotpOptions {
  /** Seconds per code. */
  step: number;
  digits: number;
  algorithm: "sha1" | "sha256" | "sha512";
  /**
   * How many steps either side of now are accepted.
   *
   * One step — thirty seconds each way — absorbs clock skew and the few seconds
   * between reading a code and pressing enter. Wider than that starts to matter
   * for replay.
   */
  window: number;
}

export const DEFAULT_TOTP: TotpOptions = {
  step: 30,
  digits: 6,
  algorithm: "sha1",
  window: 1,
};

// ------------------------------------------------------------------ base32

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the form authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  // People retype secrets with spaces and lowercase; padding is optional.
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not valid base32.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * A fresh secret.
 *
 * 20 bytes is the RFC 4226 recommendation for SHA-1 and encodes to 32 base32
 * characters — long enough to be safe, short enough to be typed by hand when a
 * camera will not read the QR.
 */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

// ------------------------------------------------------------------ the code

/** HOTP (RFC 4226): HMAC of the counter, then dynamic truncation. */
function hotp(secret: Buffer, counter: number, options: TotpOptions): string {
  const buffer = Buffer.alloc(8);
  // Counters are 64-bit; JavaScript numbers are safe to 2^53, which is far
  // beyond any wall-clock step, so the high word is written separately.
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac(options.algorithm, secret).update(buffer).digest();

  // The low nibble of the last byte picks where to read from.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** options.digits).padStart(options.digits, "0");
}

export function generateTotp(
  secret: string,
  at: Date = new Date(),
  options: TotpOptions = DEFAULT_TOTP,
): string {
  const counter = Math.floor(at.getTime() / 1000 / options.step);
  return hotp(base32Decode(secret), counter, options);
}

/**
 * Whether a code is currently valid.
 *
 * Compared in constant time, and every candidate step is evaluated rather than
 * returning early on a match — both so that timing says nothing about which
 * step matched or how close a wrong code was.
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date = new Date(),
  options: TotpOptions = DEFAULT_TOTP,
): boolean {
  const cleaned = code.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${options.digits}}$`).test(cleaned)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }

  const counter = Math.floor(at.getTime() / 1000 / options.step);
  const expected = Buffer.from(cleaned);
  let matched = false;

  for (let drift = -options.window; drift <= options.window; drift++) {
    const candidate = Buffer.from(hotp(key, counter + drift, options));
    if (
      candidate.length === expected.length &&
      crypto.timingSafeEqual(candidate, expected)
    ) {
      matched = true;
    }
  }

  return matched;
}

/** Seconds until the current code expires, for the countdown on screen. */
export function secondsRemaining(at: Date = new Date(), options: TotpOptions = DEFAULT_TOTP): number {
  return options.step - (Math.floor(at.getTime() / 1000) % options.step);
}

// ------------------------------------------------------------------ enrolment

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice by convention — as a label prefix and as a parameter
 * — because different apps read different ones, and an entry that just says
 * "sneha@acme.com" is useless once somebody has three of them.
 */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
  options?: TotpOptions;
}): string {
  const options = input.options ?? DEFAULT_TOTP;
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: options.algorithm.toUpperCase(),
    digits: String(options.digits),
    period: String(options.step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes, for the phone that ends up in a river.
 *
 * Returned in plaintext once and stored only as hashes — the same discipline as
 * a password. Without these, losing a device means an administrator has to turn
 * 2FA off for somebody, which is a social-engineering route worth closing.
 */
export interface RecoveryCodes {
  plaintext: string[];
  hashes: string[];
}

export function generateRecoveryCodes(count = 10): RecoveryCodes {
  const plaintext: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < count; i++) {
    // Groups of four from an unambiguous alphabet: no O/0 or I/1 to misread.
    const raw = crypto.randomBytes(10).toString("hex").toUpperCase().slice(0, 10);
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    plaintext.push(code);
    hashes.push(hashRecoveryCode(code));
  }

  return { plaintext, hashes };
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

/** Returns the remaining hashes when one matches, or null when none does. */
export function consumeRecoveryCode(code: string, hashes: string[]): string[] | null {
  const target = hashRecoveryCode(code);
  const index = hashes.indexOf(target);
  if (index === -1) return null;
  return hashes.filter((_, i) => i !== index);
}
