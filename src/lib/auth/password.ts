import bcrypt from "bcryptjs";
import { randomNumericCode, randomToken } from "../crypto/field";

/**
 * Password and one-time-code hashing.
 *
 * bcrypt with a cost of 12: slow enough to make offline cracking expensive, fast
 * enough that a login does not feel sluggish. Pure JS, so there is no native
 * build step to break on Windows.
 */

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Runs a bcrypt comparison against a throwaway hash.
 *
 * Called when an email does not exist so that a failed login takes the same time
 * whether or not the account is real — otherwise response timing becomes a user
 * enumeration oracle.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Vd9tK8ZBOZaLYA7WQ0h6h5MyMTLcSK";

export async function fakeVerify(): Promise<void> {
  await bcrypt.compare("not-a-real-password", DUMMY_HASH);
}

// ------------------------------------------------------------------ policy

export {
  DEFAULT_PASSWORD_POLICY,
  checkPassword,
  isPasswordExpired,
  type PasswordCheck,
  type PasswordPolicy,
} from "@/domain/password";

// ------------------------------------------------------------------ one-time codes

export interface OneTimeCode {
  plaintext: string;
  hash: string;
}

/** OTP for the superadmin-released admin password reset. */
export async function generateOtp(digits = 6): Promise<OneTimeCode> {
  const plaintext = randomNumericCode(digits);
  return { plaintext, hash: await bcrypt.hash(plaintext, 10) };
}

/** Confirmation code the Superadmin issues against a payment order. */
export async function generateConfirmationCode(): Promise<OneTimeCode> {
  const plaintext = randomNumericCode(6);
  return { plaintext, hash: await bcrypt.hash(plaintext, 10) };
}

export async function verifyCode(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/** Temporary password for a newly invited user; they must change it at first login. */
export function generateTemporaryPassword(): string {
  return `Hrms-${randomToken(6).replace(/[-_]/g, "")}-${randomNumericCode(3)}`;
}
