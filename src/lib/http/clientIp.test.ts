import { describe, expect, it } from "vitest";
import { clientIp } from "./clientIp";

const headers = (values: Record<string, string>) => new Headers(values);

describe("clientIp", () => {
  it("takes the entry the proxy appended, not the one the client sent", () => {
    // This is the whole point. Traefik appends; everything before its entry was
    // written by the caller. Reading the first entry — the conventional
    // mistake — would return "1.2.3.4" here.
    expect(
      clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("cannot be moved by a forged header", () => {
    // A caller spraying fake entries still cannot change what the proxy appends,
    // so the rate-limit bucket stays the same across all of these.
    const forged = [
      "9.9.9.9, 203.0.113.9",
      "9.9.9.9, 8.8.8.8, 203.0.113.9",
      "not-an-ip, 203.0.113.9",
      ", , 203.0.113.9",
    ];
    for (const value of forged) {
      expect(clientIp(headers({ "x-forwarded-for": value }))).toBe("203.0.113.9");
    }
  });

  it("handles a single entry — one proxy, no client header", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("tolerates the whitespace a proxy leaves behind", () => {
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4,   203.0.113.9  " }))).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to x-real-ip when there is no forwarded header", () => {
    expect(clientIp(headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("prefers the forwarded chain over x-real-ip", () => {
    expect(
      clientIp(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9", "x-real-ip": "10.0.0.1" })),
    ).toBe("203.0.113.9");
  });

  it("returns null when nothing identifies the caller", () => {
    // Local development, where the caller is the loopback interface and there is
    // no proxy to ask. Callers substitute their own fallback.
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": " , " }))).toBeNull();
  });

  it("keeps IPv6 addresses intact", () => {
    expect(clientIp(headers({ "x-forwarded-for": "::1, 2001:db8::1" }))).toBe("2001:db8::1");
  });
});
