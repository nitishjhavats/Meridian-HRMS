/**
 * Password strength rules.
 *
 * Pure logic with no dependencies, so the sign-up form can apply exactly the
 * same rules while the user types that the server applies when it decides. Two
 * separate implementations of "is this password acceptable" drift, and the way
 * you find out is a user who cannot submit a form that looks valid.
 */

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  /** Days before a password must be changed. 0 = never. */
  maxAgeDays: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
  maxAgeDays: 0,
};

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "qwerty123",
  "admin@123", "welcome1", "letmein123", "changeme", "iloveyou", "abcd1234",
]);

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
  /** 0–4, for the strength meter. */
  score: number;
}

export function checkPassword(password: string, policy = DEFAULT_PASSWORD_POLICY): PasswordCheck {
  const problems: string[] = [];

  if (password.length < policy.minLength) {
    problems.push(`Use at least ${policy.minLength} characters.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) problems.push("Add an uppercase letter.");
  if (policy.requireLowercase && !/[a-z]/.test(password)) problems.push("Add a lowercase letter.");
  if (policy.requireNumber && !/\d/.test(password)) problems.push("Add a number.");
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) problems.push("Add a symbol.");
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push("That password is too common. Choose something less predictable.");
  }

  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;

  return { ok: problems.length === 0, problems, score: Math.min(4, score) };
}

export function isPasswordExpired(
  changedAt: Date | null | undefined,
  policy = DEFAULT_PASSWORD_POLICY,
  now = new Date(),
): boolean {
  if (policy.maxAgeDays <= 0 || !changedAt) return false;
  const ageDays = (now.getTime() - changedAt.getTime()) / 86_400_000;
  return ageDays > policy.maxAgeDays;
}
