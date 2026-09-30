import zlib from "node:zlib";

/**
 * A minimal ZIP writer.
 *
 * Written here rather than pulled in because the format is small, `zlib` is
 * already in Node, and an export archive should not depend on a package that
 * might one day disappear from the registry. What it produces is a plain
 * PKZIP 2.0 archive — 7-Zip, Windows Explorer, macOS Archive Utility and
 * `unzip` all open it without being told anything.
 *
 * Deliberately not implemented: ZIP encryption. Both the legacy ZipCrypto
 * scheme and WinZip AES are error-prone to hand-roll, and the archive is
 * encrypted as a whole instead — see `archive.ts`.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. "tables/employee.json". */
  name: string;
  data: Buffer;
}

// ------------------------------------------------------------------ crc32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/** CRC-32/ISO-HDLC, the checksum every ZIP entry carries. */
export function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// ------------------------------------------------------------------ writer

/** MS-DOS packed date and time, which is what the format stores. */
function dosStamp(at: Date): { time: number; date: number } {
  // The epoch is 1980; anything earlier cannot be represented, so clamp rather
  // than write a date that reads as garbage in a file browser.
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const MAX_ENTRY_BYTES = 0xffffffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

/** Bit 11: the name is UTF-8, so non-ASCII paths survive. */
const FLAG_UTF8 = 0x0800;

export function createZip(entries: ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosStamp(at);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const size = entry.data.length;
    if (size > MAX_ENTRY_BYTES) {
      throw new Error(`"${entry.name}" is too large for a ZIP32 archive.`);
    }

    // Compress, but keep the original when deflating made it bigger — which it
    // does for anything already compressed.
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= size;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // no extra field
    local.push(header, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIG, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...local, directory, end]);
}

// ------------------------------------------------------------------ reader

/**
 * Reads an archive back.
 *
 * Only used by the tests — but a writer nobody can read is a writer nobody has
 * checked, and this is what proves the bytes above are a real ZIP rather than
 * something that merely starts with the right four.
 */
export function readZip(archive: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cursor = 0;

  while (cursor + 30 <= archive.length && archive.readUInt32LE(cursor) === LOCAL_SIG) {
    const method = archive.readUInt16LE(cursor + 8);
    const crc = archive.readUInt32LE(cursor + 14);
    const compressedSize = archive.readUInt32LE(cursor + 18);
    const nameLength = archive.readUInt16LE(cursor + 26);
    const extraLength = archive.readUInt16LE(cursor + 28);

    const nameStart = cursor + 30;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const dataStart = nameStart + nameLength + extraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);

    const data = method === 0 ? Buffer.from(payload) : zlib.inflateRawSync(payload);
    if (crc32(data) !== crc) throw new Error(`"${name}" is corrupt.`);
    entries.push({ name, data });

    cursor = dataStart + compressedSize;
  }

  return entries;
}
