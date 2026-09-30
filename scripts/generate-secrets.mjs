/**
 * Fresh production secrets.
 *
 *   npm run secrets
 *
 * Prints them once, to this terminal, and writes nothing. Copy them straight
 * into the deployment's environment — they should not pass through a file, a
 * chat window, or a commit on their way there.
 *
 * A word about PLATFORM_ENCRYPTION_KEY in particular: it encrypts PAN, Aadhaar,
 * bank details, TOTP secrets and organisation API keys. Lose it and none of
 * that is recoverable; change it and every value already stored stops
 * decrypting. It belongs in a password manager before it protects anything
 * real, not after.
 */

import crypto from "node:crypto";

const secrets = [
  {
    name: "AUTH_SECRET",
    value: crypto.randomBytes(48).toString("base64url"),
    note: "signs session cookies — rotating it signs everybody out, which is survivable",
  },
  {
    name: "PLATFORM_ENCRYPTION_KEY",
    value: crypto.randomBytes(32).toString("base64url"),
    note: "encrypts stored secrets — rotating it destroys them, which is not",
  },
  {
    name: "JOBS_SECRET",
    value: crypto.randomBytes(32).toString("base64url"),
    note: "authorises the maintenance endpoint",
  },
];

console.log("\nFresh secrets. Copy these into the deployment environment now;");
console.log("this prints them once and keeps no copy.\n");

for (const secret of secrets) {
  console.log(`# ${secret.note}`);
  console.log(`${secret.name}="${secret.value}"\n`);
}

console.log("Back up PLATFORM_ENCRYPTION_KEY somewhere durable before first use.\n");
