import { describe, expect, it } from "vitest";
import { decryptArchive, encryptArchive, generatePassphrase } from "./archive";

const PLAIN = Buffer.from("PK pretend this is a zip");

describe("encryptArchive", () => {
  it("round-trips with the right passphrase", () => {
    const locked = encryptArchive(PLAIN, "OPEN-SESAME");
    expect(decryptArchive(locked, "OPEN-SESAME")).toEqual(PLAIN);
  });

  it("hides the contents", () => {
    const locked = encryptArchive(PLAIN, "OPEN-SESAME");
    expect(locked.includes("pretend this is a zip")).toBe(false);
    expect(locked.subarray(0, 6).toString("ascii")).toBe("HRMSX1");
  });

  it("produces different bytes each time for the same input", () => {
    // A fresh salt and IV per archive: two exports of identical data must not
    // be comparable to each other.
    const a = encryptArchive(PLAIN, "OPEN-SESAME");
    const b = encryptArchive(PLAIN, "OPEN-SESAME");
    expect(a.equals(b)).toBe(false);
  });

  it("refuses the wrong passphrase", () => {
    const locked = encryptArchive(PLAIN, "OPEN-SESAME");
    expect(() => decryptArchive(locked, "open-sesame")).toThrow(/did not unlock/);
  });

  it("refuses a tampered archive", () => {
    const locked = encryptArchive(PLAIN, "OPEN-SESAME");
    locked[locked.length - 1] = locked[locked.length - 1]! ^ 0xff;
    expect(() => decryptArchive(locked, "OPEN-SESAME")).toThrow(/did not unlock/);
  });

  it("says so plainly when handed something that is not an archive", () => {
    expect(() => decryptArchive(Buffer.from("hello"), "x")).toThrow(/not an export archive/);
  });

  it("treats a retyped passphrase the same after Unicode normalisation", () => {
    const locked = encryptArchive(PLAIN, "café-KEY");
    expect(decryptArchive(locked, "café-KEY".normalize("NFD"))).toEqual(PLAIN);
  });
});

describe("generatePassphrase", () => {
  it("is grouped and unambiguous", () => {
    const passphrase = generatePassphrase();
    expect(passphrase).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    // No character that gets misread when copied by hand.
    expect(passphrase).not.toMatch(/[OI01]/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassphrase()));
    expect(seen.size).toBe(50);
  });
});
