import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOTP,
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateSecret,
  generateTotp,
  hashRecoveryCode,
  otpauthUri,
  secondsRemaining,
  verifyTotp,
} from "./totp";

/**
 * The RFC 6238 test vectors.
 *
 * The seed is the ASCII "12345678901234567890" the RFC specifies, expressed in
 * base32 because that is what this module takes. If these pass, the algorithm
 * is right; if they do not, nothing else in this file matters.
 */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 200]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("matches the RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("tolerates how people actually retype a secret", () => {
    const secret = base32Encode(Buffer.from("hello"));
    expect(base32Decode(secret.toLowerCase())).toEqual(base32Decode(secret));
    expect(base32Decode("mzxw 6ytb-oi")).toEqual(base32Decode("MZXW6YTBOI"));
    expect(base32Decode("MZXW6YTBOI===")).toEqual(base32Decode("MZXW6YTBOI"));
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("MZXW6YTB!")).toThrow();
  });
});

describe("generateTotp — RFC 6238 vectors", () => {
  // The RFC publishes 8-digit codes; this asserts the last six, which is what a
  // 6-digit authenticator shows for the same instant.
  const cases: [number, string][] = [
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
  ];

  for (const [seconds, expected] of cases) {
    it(`matches at T=${seconds}`, () => {
      expect(generateTotp(RFC_SECRET, new Date(seconds * 1000))).toBe(expected);
    });
  }

  it("produces a different code in the next step", () => {
    const now = new Date(1_111_111_109 * 1000);
    const later = new Date(now.getTime() + DEFAULT_TOTP.step * 1000);
    expect(generateTotp(RFC_SECRET, now)).not.toBe(generateTotp(RFC_SECRET, later));
  });

  it("produces the same code throughout one step", () => {
    const start = new Date(1_111_111_080 * 1000);
    const nearEnd = new Date(start.getTime() + 29_000);
    expect(generateTotp(RFC_SECRET, start)).toBe(generateTotp(RFC_SECRET, nearEnd));
  });
});

describe("verifyTotp", () => {
  const at = new Date(1_111_111_109 * 1000);

  it("accepts the current code", () => {
    expect(verifyTotp(RFC_SECRET, generateTotp(RFC_SECRET, at), at)).toBe(true);
  });

  it("accepts one step of drift either way", () => {
    const step = DEFAULT_TOTP.step * 1000;
    const past = generateTotp(RFC_SECRET, new Date(at.getTime() - step));
    const future = generateTotp(RFC_SECRET, new Date(at.getTime() + step));
    expect(verifyTotp(RFC_SECRET, past, at)).toBe(true);
    expect(verifyTotp(RFC_SECRET, future, at)).toBe(true);
  });

  it("rejects a code two steps old", () => {
    const stale = generateTotp(RFC_SECRET, new Date(at.getTime() - 2 * DEFAULT_TOTP.step * 1000));
    expect(verifyTotp(RFC_SECRET, stale, at)).toBe(false);
  });

  it("rejects a wrong code", () => {
    expect(verifyTotp(RFC_SECRET, "000000", at)).toBe(false);
  });

  it("rejects anything that is not six digits", () => {
    expect(verifyTotp(RFC_SECRET, "12345", at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "1234567", at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", at)).toBe(false);
  });

  it("accepts a code the user typed with a space", () => {
    const code = generateTotp(RFC_SECRET, at);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(true);
  });

  it("returns false rather than throwing on a corrupt secret", () => {
    // A decryption failure must not become a 500 on the login path.
    expect(verifyTotp("not!base32", "123456", at)).toBe(false);
  });

  it("does not accept another secret's code", () => {
    const other = generateSecret();
    expect(verifyTotp(RFC_SECRET, generateTotp(other, at), at)).toBe(false);
  });
});

describe("secondsRemaining", () => {
  it("counts down within the step", () => {
    expect(secondsRemaining(new Date(1_111_111_080 * 1000))).toBe(30);
    expect(secondsRemaining(new Date(1_111_111_099 * 1000))).toBe(11);
  });
});

describe("otpauthUri", () => {
  it("carries everything an app needs to reproduce the code", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "sneha@acme.com", issuer: "HRMS" });
    expect(uri).toContain("otpauth://totp/HRMS%3Asneha%40acme.com");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=HRMS");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("recovery codes", () => {
  it("returns plaintext once and stores only hashes", () => {
    const { plaintext, hashes } = generateRecoveryCodes(5);
    expect(plaintext).toHaveLength(5);
    expect(hashes).toHaveLength(5);
    // No hash may reveal its code.
    for (const code of plaintext) expect(hashes).not.toContain(code);
    for (const code of plaintext) expect(hashes).toContain(hashRecoveryCode(code));
  });

  it("uses one up and leaves the rest", () => {
    const { plaintext, hashes } = generateRecoveryCodes(3);
    const remaining = consumeRecoveryCode(plaintext[1]!, hashes);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(hashRecoveryCode(plaintext[1]!));
  });

  it("cannot be used twice", () => {
    const { plaintext, hashes } = generateRecoveryCodes(3);
    const remaining = consumeRecoveryCode(plaintext[0]!, hashes)!;
    expect(consumeRecoveryCode(plaintext[0]!, remaining)).toBeNull();
  });

  it("ignores the formatting dash a user may or may not type", () => {
    const { plaintext, hashes } = generateRecoveryCodes(2);
    const code = plaintext[0]!;
    expect(consumeRecoveryCode(code.replace("-", ""), hashes)).not.toBeNull();
    expect(consumeRecoveryCode(code.toLowerCase(), hashes)).not.toBeNull();
  });

  it("rejects a code that was never issued", () => {
    const { hashes } = generateRecoveryCodes(3);
    expect(consumeRecoveryCode("AAAAA-BBBBB", hashes)).toBeNull();
  });
});
