import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as passwordReset from "./passwordReset";
import {
  GENERIC_MESSAGE,
  SUPERADMIN_RELEASED_ROLES,
  eligibleForSuperadminRelease,
  type ResetRequestResult,
} from "./passwordReset";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  effectivePermissions,
  type SystemRole,
} from "@/lib/auth/permissions";

/**
 * A reset flow whose safety is mostly made of things that are *absent*.
 *
 * Four of the five promises this file makes cannot be seen by exercising the
 * happy path, because the happy path keeps working after each of them is
 * broken: an early return for an unknown address, a code copied into the
 * notification, a `status: { in: [...] }` that also accepts PENDING. Each is one
 * line, each is plausible as a "small improvement", and none of them fails a
 * test that only checks that a legitimate reset succeeds.
 *
 * So the eligibility rule is tested as the pure function it now is, and the rest
 * are read out of the source with the consequence written next to them. There is
 * no Prisma here and there should not be: none of these decisions is a query
 * result, and running them against a database would test the seed instead.
 */

const SOURCE = readFileSync(path.resolve("src/services/auth/passwordReset.ts"), "utf8");

/**
 * The source with comments removed. Prose about a rule must never be mistaken
 * for the rule — this file's comments talk about codes and OTPs constantly.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** One exported function, from its signature to the closing brace in column one. */
function body(name: string): string {
  const start = CODE.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`passwordReset.ts no longer exports ${name}`);
  const after = CODE.slice(start);
  const end = after.indexOf("\n}\n");
  return end === -1 ? after : after.slice(0, end);
}

const user = (over: { role?: string; status?: string } = {}) => ({
  id: "u1",
  email: "asha@example.com",
  role: "ORG_OWNER",
  status: "ACTIVE",
  ...over,
});

describe("the request endpoint is not a directory of who works where", () => {
  it("returns one constant, on every path", () => {
    const request = body("requestPasswordReset");

    // An `if (eligible.length === 0) return { message: "No such account" }` — or
    // a NotFoundError, which is the same oracle with a status code — would make
    // this endpoint answer the question "does this person work at a company
    // that uses this product, and are they an admin there". Every existing
    // happy-path test would still pass. So: exactly one return, no throw.
    expect(request.match(/\breturn\b/g) ?? []).toHaveLength(1);
    expect(request).not.toMatch(/\bthrow\b/);
    expect(request).toMatch(
      /return \{\s*message: GENERIC_MESSAGE,\s*requiresSuperadminRelease: true,\s*\};/,
    );
  });

  it("says the same thing whoever asked", () => {
    // Nothing interpolated: no name, no organisation, no "we have emailed you".
    expect(GENERIC_MESSAGE).not.toContain("${");
    expect(GENERIC_MESSAGE.toLowerCase()).toContain("if that account exists");
  });

  it("puts nothing else on the wire", () => {
    // The route returns this object verbatim. The Record is the real assertion:
    // a field added to ResetRequestResult and not named here fails `tsc`, which
    // is the moment to ask whether it tells the caller something about an
    // account that may not be theirs.
    const fields: Record<keyof ResetRequestResult, true> = {
      message: true,
      requiresSuperadminRelease: true,
    };
    expect(Object.keys(fields).sort()).toEqual(["message", "requiresSuperadminRelease"]);
  });

  it("mints no code for the three cases the answer cannot distinguish", () => {
    // Unknown address, suspended account, role that resets through its own HR
    // team. All three produce nothing, and all three produce the same reply.
    expect(eligibleForSuperadminRelease([])).toEqual([]);
    expect(eligibleForSuperadminRelease([user({ status: "INACTIVE" })])).toEqual([]);
    expect(eligibleForSuperadminRelease([user({ status: "SUSPENDED" })])).toEqual([]);
    expect(
      eligibleForSuperadminRelease([user({ role: "HR_MANAGER" }), user({ role: "TEAM_MEMBER" })]),
    ).toEqual([]);
  });

  it("mints one for an active owner or admin, and for nobody else", () => {
    const owner = user({ role: "ORG_OWNER" });
    const admin = user({ role: "ADMIN" });
    expect(eligibleForSuperadminRelease([owner, admin])).toEqual([owner, admin]);

    expect([...SUPERADMIN_RELEASED_ROLES]).toEqual(["ORG_OWNER", "ADMIN"]);
    const otherRoles = (Object.keys(ROLE_PERMISSIONS) as SystemRole[]).filter(
      (role) => !(SUPERADMIN_RELEASED_ROLES as readonly string[]).includes(role),
    );
    for (const role of otherRoles) {
      // Includes SUPERADMIN itself: the platform owner does not release their
      // own reset code to themselves.
      expect(eligibleForSuperadminRelease([user({ role })]), role).toEqual([]);
    }
  });
});

describe("the plaintext leaves by exactly one door", () => {
  it("is written to the encrypted column and nowhere else", () => {
    const uses = CODE.match(/otp\.plaintext/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(CODE).toMatch(/otpCipher: encryptField\(otp\.plaintext\)/);
  });

  it("is in no notification and no audit row", () => {
    const calls =
      CODE.match(
        /(?:notify\.toSuperadmins|writeAnonymousAudit|writeAudit)\([\s\S]*?\n\s*\}\);/g,
      ) ?? [];

    // Six: four audit rows and two notifications. `requestPasswordReset` and
    // `completePasswordReset` write one of each; `releaseOtp` and
    // `rejectResetRequest` write an audit row and notify nobody. If this count
    // changes, a door was added — read the new call and satisfy yourself it is
    // not carrying the code, then update the number.
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call, call.slice(0, 48)).not.toMatch(/otp|plaintext|cipher|\bcode\b/i);
    }
  });

  it("comes back out of releaseOtp alone", () => {
    const signatures = [
      ...CODE.matchAll(/export async function (\w+)\([\s\S]*?\): (Promise<[^>]*>)/g),
    ].map((m) => ({ name: m[1], returns: m[2] }));

    expect(signatures.map((s) => s.name).sort()).toEqual([
      "completePasswordReset",
      "listResetRequests",
      "rejectResetRequest",
      "releaseOtp",
      "requestPasswordReset",
    ]);
    // The only entry point that hands a string back to its caller. A second one
    // would be a second door, and the console is not the only thing that calls
    // this module.
    expect(signatures.filter((s) => s.returns === "Promise<string>").map((s) => s.name)).toEqual([
      "releaseOtp",
    ]);

    expect(CODE.match(/decryptOptional\(/g) ?? []).toHaveLength(1);
    const release = body("releaseOtp");
    expect(release).toMatch(/const code = decryptOptional\(request\.otpCipher\)/);
    expect(release).toMatch(/return code;/);
    // Audited on the way out, re-reads included, so repeated viewing of one
    // code is visible afterwards.
    expect(release).toMatch(/reRead: request\.releasedAt != null/);
  });

  it("keeps the module's surface to what is listed here", () => {
    // A new export is the cheap way to add a seventh door; this fails at review
    // rather than in production.
    expect(Object.keys(passwordReset).sort()).toEqual([
      "GENERIC_MESSAGE",
      "SUPERADMIN_RELEASED_ROLES",
      "completePasswordReset",
      "eligibleForSuperadminRelease",
      "listResetRequests",
      "rejectResetRequest",
      "releaseOtp",
      "requestPasswordReset",
    ]);
  });
});

describe("exactly one code is live per user", () => {
  it("expires the earlier requests before creating the new one", () => {
    const request = body("requestPasswordReset");
    const expired = request.indexOf('status: { in: ["PENDING", "RELEASED"] }');
    const created = request.indexOf("prisma.passwordResetRequest.create(");

    expect(expired).toBeGreaterThan(-1);
    expect(request).toMatch(/updateMany\(\{[\s\S]*?data: \{ status: "EXPIRED" \}/);
    expect(created).toBeGreaterThan(expired);

    // RELEASED is the half that is easy to drop as redundant. Without it, a code
    // the owner has already read out over the phone stays spendable next to a
    // freshly minted one, and the person who wrote the old one down still has a
    // working reset for an account they may no longer be entitled to.
  });
});

describe("a pending request cannot be spent", () => {
  it("looks only for one the superadmin released", () => {
    const complete = body("completePasswordReset");

    expect(complete).toMatch(/status: "RELEASED",/);
    // Widening this to `status: { in: ["PENDING", "RELEASED"] }` deletes the
    // human gate this whole file exists for — the code is minted at request
    // time, so anyone who obtains it could reset before a person approved
    // anything — and every happy path still passes, because a released request
    // matches either way.
    expect(complete).not.toMatch(/status: \{\s*in:/);
  });

  it("actually calls the filter, which is the half a pure test cannot see", () => {
    // The extraction below is well covered, and deleting the CALL to it left
    // every one of those tests green while `requestPasswordReset` minted a code
    // and raised a superadmin notification for every account on the address --
    // suspended, inactive, team member, all of them. Pinning a pure function
    // without pinning its one caller pins nothing.
    expect(body("requestPasswordReset")).toMatch(/eligibleForSuperadminRelease\(users\)/);
  });

  it("caps the guesses at a released code", () => {
    // Six digits with unlimited attempts is not a gate.
    // Anchored on the closing bracket. `/attemptCount >= 5/` also matches
    // `>= 500`, so the regex that was meant to pin a five-guess cap passed a
    // five-hundred-guess one -- found by mutation, not by reading.
    expect(body("completePasswordReset")).toMatch(/request\.attemptCount >= 5\)/);
  });

  it("stays behind a permission an organisation role cannot be granted", () => {
    expect(PERMISSIONS).toContain("platform.passwordreset.release");

    const holders = (Object.keys(ROLE_PERMISSIONS) as SystemRole[]).filter((role) =>
      (ROLE_PERMISSIONS[role] as readonly string[]).includes("platform.passwordreset.release"),
    );
    expect(holders).toEqual(["SUPERADMIN"]);

    // Not even by a per-user grant: an org owner who could grant themselves the
    // release permission would be releasing codes for their own admins.
    const granted = effectivePermissions("ORG_OWNER", [
      { permission: "platform.passwordreset.release", granted: true },
      { permission: "platform.passwordreset.read", granted: true },
    ]);
    expect(granted.has("platform.passwordreset.release")).toBe(false);
    expect(granted.has("platform.passwordreset.read")).toBe(false);

    for (const name of ["listResetRequests", "releaseOtp", "rejectResetRequest"]) {
      expect(body(name), name).toMatch(/requireSuperadmin\(ctx\)/);
    }
  });
});

describe("a completed reset ends every session", () => {
  it("revokes them after the password has actually changed", () => {
    const complete = body("completePasswordReset");
    const transaction = complete.indexOf("prisma.$transaction(");
    const revoke = complete.indexOf("revokeAllSessions(request.userId)");

    expect(transaction).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(transaction);
    // Whoever forced the reset may be holding a session cookie for the same
    // account; leaving it alive makes the reset cosmetic.
  });

  it("spends the request in the same transaction as the new password", () => {
    const complete = body("completePasswordReset");
    expect(complete).toMatch(/status: "CONSUMED"/);
    // A new password with the code still spendable is a second free reset.
    expect(complete).toMatch(/otpCipher: null/);
  });
});
