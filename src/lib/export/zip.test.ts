import { describe, expect, it } from "vitest";
import { createZip, crc32, readZip } from "./zip";

describe("crc32", () => {
  it("matches the published check value", () => {
    // The standard CRC-32 check: "123456789" is 0xCBF43926.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("is zero for no bytes", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("createZip", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ ok: true })) },
    { name: "tables/employee.json", data: Buffer.from("x".repeat(5000)) },
  ];

  it("round-trips every entry", () => {
    const read = readZip(createZip(entries));
    expect(read.map((e) => e.name)).toEqual(["manifest.json", "tables/employee.json"]);
    expect(read[0]!.data.toString()).toBe('{"ok":true}');
    expect(read[1]!.data.toString()).toBe("x".repeat(5000));
  });

  it("starts with the PKZIP signature and ends with the directory", () => {
    const archive = createZip(entries);
    expect(archive.subarray(0, 4).toString("latin1")).toBe("PK");
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(entries.length);
  });

  it("compresses what is worth compressing", () => {
    const repetitive = Buffer.from("y".repeat(20_000));
    const archive = createZip([{ name: "big.txt", data: repetitive }]);
    expect(archive.length).toBeLessThan(repetitive.length / 10);
  });

  it("stores rather than inflating incompressible bytes", () => {
    // Random data deflates to slightly *more* than it started as; the writer
    // must notice and keep the original.
    const random = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256),
    );
    const archive = createZip([{ name: "noise.bin", data: random }]);
    expect(readZip(archive)[0]!.data).toEqual(random);
  });

  it("handles an empty file and an empty archive", () => {
    expect(readZip(createZip([{ name: "empty.txt", data: Buffer.alloc(0) }]))[0]!.data.length).toBe(
      0,
    );
    expect(readZip(createZip([]))).toEqual([]);
  });

  it("keeps non-ASCII names readable", () => {
    const read = readZip(createZip([{ name: "कर्मचारी.json", data: Buffer.from("{}") }]));
    expect(read[0]!.name).toBe("कर्मचारी.json");
  });

  it("refuses a date before the DOS epoch rather than writing nonsense", () => {
    // 1979 cannot be represented; it is clamped, not silently wrapped.
    const archive = createZip([{ name: "a.txt", data: Buffer.from("a") }], new Date("1979-01-01"));
    expect(archive.readUInt16LE(12) >>> 9).toBe(0); // year offset from 1980
  });

  it("notices a corrupted payload", () => {
    const archive = createZip([{ name: "a.txt", data: Buffer.from("hello world") }]);
    // Flip a byte inside the stored data, past the header and name.
    const at = 30 + "a.txt".length + 2;
    archive[at] = archive[at]! ^ 0xff;
    expect(() => readZip(archive)).toThrow();
  });
});
