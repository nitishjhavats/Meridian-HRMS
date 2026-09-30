/** Proves the 60-day selfie purge: a real file, backdated, then swept. */
import sharp from "sharp";
import { prisma } from "../src/lib/db/prisma";
import { COMPRESSION, buildKey, compressImage, storage } from "../src/lib/storage";
import { getSelfieStorageReport, purgeExpiredSelfies } from "../src/services/attendance/retention";

const employee = await prisma.employee.findFirstOrThrow({ where: { employeeCode: "ACM007" } });
const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;

// A realistically large "phone selfie".
const original = await sharp({
  create: { width: 3000, height: 4000, channels: 3, background: { r: 180, g: 140, b: 120 } },
})
  .jpeg({ quality: 96 })
  .toBuffer();

const compressed = await compressImage(original, COMPRESSION.selfie);
const key = buildKey(employee.organizationId, "selfies", compressed.extension);
await storage().put(key, compressed.data, compressed.mimeType, {
  organizationId: employee.organizationId,
  kind: "selfies",
});

console.log(`  uploaded      ${kb(original.length)} → ${kb(compressed.compressedBytes)} stored`);

// Two events: one 90 days old (past retention), one from today.
const old = await prisma.attendanceEvent.create({
  data: {
    organizationId: employee.organizationId,
    employeeId: employee.id,
    type: "CHECK_IN",
    occurredAt: new Date(Date.now() - 90 * 86_400_000),
    selfieKey: key,
    source: "SELF_GPS",
  },
});

const freshKey = buildKey(employee.organizationId, "selfies", compressed.extension);
await storage().put(freshKey, compressed.data, compressed.mimeType, {
  organizationId: employee.organizationId,
  kind: "selfies",
});
const fresh = await prisma.attendanceEvent.create({
  data: {
    organizationId: employee.organizationId,
    employeeId: employee.id,
    type: "CHECK_IN",
    occurredAt: new Date(),
    selfieKey: freshKey,
    faceMatchScore: 0.6316,
    faceMatchPassed: true,
    source: "SELF_GPS",
  },
});

const before = await getSelfieStorageReport();
console.log(`  before purge  ${before.storedCount} files, ${kb(before.storedBytes)}, ${before.awaitingPurge} expired`);

const result = await purgeExpiredSelfies();
console.log(`  purged        ${result.purged} file(s), ${kb(result.freedBytes)} freed (cutoff ${result.cutoff.toISOString().slice(0, 10)})`);

const oldAfter = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: old.id } });
const freshAfter = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: fresh.id } });

console.log(`  90-day event  selfie=${oldAfter.selfieKey ?? "deleted"} purgedAt=${oldAfter.selfiePurgedAt ? "set" : "—"} record=${oldAfter.occurredAt.toISOString().slice(0, 10)} still present`);
console.log(`  today's event selfie=${freshAfter.selfieKey ? "kept" : "GONE — BUG"} score=${freshAfter.faceMatchScore ?? "—"}`);
console.log(`  old file gone from storage? ${(await storage().exists(key)) ? "NO — BUG" : "yes"}`);

// Clean up the two synthetic events.
await prisma.attendanceEvent.deleteMany({ where: { id: { in: [old.id, fresh.id] } } });
await storage().delete(freshKey);
await prisma.$disconnect();
