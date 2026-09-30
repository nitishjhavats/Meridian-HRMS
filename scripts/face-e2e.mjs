/**
 * End-to-end check of face-verified attendance, over real HTTP.
 *
 * Enrols a reference photo for an employee, then tries to check in as that
 * person and as somebody else, in both ADVISORY and REQUIRED modes.
 *
 *   node --env-file=.env scripts/face-e2e.mjs
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const prisma = new PrismaClient();

// Public-domain official portraits, fetched transiently and deleted afterwards.
const PHOTOS = {
  reference: "https://commons.wikimedia.org/wiki/Special:FilePath/Official_portrait_of_Barack_Obama.jpg?width=600",
  samePerson: "https://commons.wikimedia.org/wiki/Special:FilePath/President_Barack_Obama.jpg?width=600",
  otherPerson: "https://commons.wikimedia.org/wiki/Special:FilePath/Joe_Biden_presidential_portrait.jpg?width=600",
};

await mkdir(".tmp-e2e", { recursive: true });
for (const [name, url] of Object.entries(PHOTOS)) {
  const response = await fetch(url, { headers: { "User-Agent": "hrms-dev-e2e" } });
  await writeFile(`.tmp-e2e/${name}.jpg`, Buffer.from(await response.arrayBuffer()));
}

// --------------------------------------------------------------- http helpers

let cookie = "";

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const login = (email, password) =>
  request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

async function photoBlob(name) {
  return new Blob([await readFile(`.tmp-e2e/${name}.jpg`)], { type: "image/jpeg" });
}

/** Rewrites the org's stored attendance policy so the test can flip modes. */
async function setFaceMode(organizationId, mode) {
  const version = await prisma.orgPolicyVersion.findFirst({
    where: { organizationId, kind: "ATTENDANCE", active: true },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  const payload = { ...version.payload, faceMatch: { ...(version.payload.faceMatch ?? {}), mode } };
  await prisma.orgPolicyVersion.update({ where: { id: version.id }, data: { payload } });
}

const line = (label, detail) => console.log(`  ${label.padEnd(38)} ${detail}`);

// --------------------------------------------------------------- the scenario

const employee = await prisma.employee.findFirst({
  where: { employeeCode: "ACM007" },
  select: {
    id: true,
    organizationId: true,
    firstName: true,
    lastName: true,
    user: { select: { email: true } },
    workLocation: { select: { latitude: true, longitude: true, radiusMeters: true } },
  },
});

const inside = {
  latitude: Number(employee.workLocation.latitude) + 0.0002, // ~22 m away
  longitude: Number(employee.workLocation.longitude),
};
const outside = {
  latitude: Number(employee.workLocation.latitude) + 0.02, // ~2.2 km away
  longitude: Number(employee.workLocation.longitude),
};

console.log(`\nFace-verified attendance — ${employee.firstName} ${employee.lastName} (${employee.user.email})\n`);

// 1. HR enrols the reference photo.
await login("anita.desai@acme.com", "Password@123");
const enrolForm = new FormData();
enrolForm.set("photo", await photoBlob("reference"), "reference.jpg");
const enrolled = await request(`/api/employees/${employee.id}/face`, {
  method: "POST",
  body: enrolForm,
});
line("HR enrols reference photo", `${enrolled.status} quality=${enrolled.body?.quality ?? enrolled.body?.error?.message}`);

// A photo with no face must be refused at enrolment.
const blankForm = new FormData();
blankForm.set("photo", new Blob([Buffer.alloc(64 * 64 * 3, 128)], { type: "image/jpeg" }), "blank.jpg");
const blank = await request(`/api/employees/${employee.id}/face`, { method: "POST", body: blankForm });
line("enrolling a non-photo", `${blank.status} "${blank.body?.error?.message ?? ""}"`);

// 2. The employee marks attendance.
async function mark(type, photo, coords) {
  const form = new FormData();
  form.set("type", type);
  form.set("latitude", String(coords.latitude));
  form.set("longitude", String(coords.longitude));
  form.set("accuracyMeters", "12");
  form.set("selfie", await photoBlob(photo), "selfie.jpg");
  return request("/api/attendance/mark", { method: "POST", body: form });
}

// ---- REQUIRED: a mismatch must be refused outright.
await setFaceMode(employee.organizationId, "REQUIRED");
await login(employee.user.email, "Password@123");

const wrongPlace = await mark("CHECK_IN", "samePerson", outside);
line("REQUIRED · right face, wrong place", `${wrongPlace.status} "${wrongPlace.body?.error?.message ?? ""}"`);

const stranger = await mark("CHECK_IN", "otherPerson", inside);
line("REQUIRED · wrong face, right place", `${stranger.status} "${stranger.body?.error?.message ?? ""}"`);

const correct = await mark("CHECK_IN", "samePerson", inside);
line(
  "REQUIRED · right face, right place",
  `${correct.status} matched=${correct.body?.face?.matched} confidence=${correct.body?.face?.confidence} status=${correct.body?.status}`,
);

const duplicate = await mark("CHECK_IN", "samePerson", inside);
line("REQUIRED · checking in twice", `${duplicate.status} "${duplicate.body?.error?.message ?? ""}"`);

// ---- ADVISORY: a mismatch is recorded but must not block.
await setFaceMode(employee.organizationId, "ADVISORY");
const advisory = await mark("CHECK_OUT", "otherPerson", inside);
line(
  "ADVISORY · wrong face",
  `${advisory.status} matched=${advisory.body?.face?.matched} flagged=${advisory.body?.face?.flagged}`,
);

// 3. What landed in the database.
const events = await prisma.attendanceEvent.findMany({
  where: { employeeId: employee.id, occurredAt: { gte: new Date(Date.now() - 600_000) } },
  orderBy: { occurredAt: "asc" },
  select: {
    type: true,
    faceMatchScore: true,
    faceMatchPassed: true,
    faceMatchReason: true,
    flaggedForReview: true,
    attendanceDayId: true,
    distanceMeters: true,
  },
});

console.log("\n  Recorded events:");
for (const e of events) {
  console.log(
    `    ${e.type.padEnd(10)} score=${e.faceMatchScore ? Number(e.faceMatchScore).toFixed(4) : "—".padEnd(6)} passed=${String(e.faceMatchPassed).padEnd(5)} flagged=${String(e.flaggedForReview).padEnd(5)} day=${e.attendanceDayId ? "attached" : "none (refused)"} ${e.faceMatchReason ?? ""}`,
  );
}

// Reset for the demo and clean up.
await setFaceMode(employee.organizationId, "ADVISORY");
await rm(".tmp-e2e", { recursive: true, force: true });
await prisma.$disconnect();
console.log("");
