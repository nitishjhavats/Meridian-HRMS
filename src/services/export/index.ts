import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireWritable } from "@/lib/auth/guard";
import type { AuthContext as ExportContext } from "@/lib/auth/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { enforce } from "@/lib/ratelimit";
import { buildKey, storage } from "@/lib/storage";
import { createZip, type ZipEntry } from "@/lib/export/zip";
import { encryptArchive, decryptArchive, generatePassphrase } from "@/lib/export/archive";
import { BRAND } from "@/lib/brand";
import { TABLES } from "./tables";
import {
  IDENTIFIER_NOTICE,
  REVEALED_IDENTIFIERS,
  revealedAs,
} from "@/domain/export/identifiers";

/**
 * Encrypted data export.
 *
 * One organisation's records, gathered into a ZIP of JSON files, locked with a
 * passphrase that is shown once and then only ever revealed back to the person
 * who asked. The file itself is stored encrypted, so a copy of the storage
 * without the passphrase is worth nothing.
 *
 * Two rules shape everything below.
 *
 * First, **redaction is by pattern, not by list**. Any column whose name looks
 * like a secret — a cipher, a hash, a token — is replaced before it is written,
 * so a column added to the schema next month is redacted the day it appears
 * rather than the day somebody remembers to update this file.
 *
 * That rule is intact, and it now has a short, explicit set of exceptions in
 * `domain/export/identifiers.ts`: an employee's PAN, UAN and bank details are
 * decrypted into readable fields, because an organisation leaving this product
 * cannot pay its staff on the other side without them. Everything else — every
 * hash, every token, the face descriptors, the blood group — stays redacted,
 * and a `*Cipher` column added tomorrow is still redacted the day it appears.
 *
 * Second, **the export is built where it is asked for**. There is no queue to
 * watch and no worker to be running; an organisation's data is small enough that
 * the request finishes it. `ExportStatus` still moves QUEUED → RUNNING → READY,
 * so a failure leaves a row saying what went wrong instead of nothing at all.
 */

/** How long a finished export can be downloaded before it is swept away. */
const LIFETIME_HOURS = 48;

/** Audit rows are unbounded; the newest are the useful ones. */
const AUDIT_LIMIT = 10_000;

/**
 * Anything matching this is written as "[redacted]".
 *
 * Wide on purpose. A false positive costs a column in an export; a false
 * negative puts somebody's Aadhaar in a file that leaves the building.
 */
const SECRET_COLUMN = /(cipher|hash|secret|token|password|descriptor)/i;


/**
 * Prisma's delegates are individually typed and there are fifty of them here.
 * Naming each one would be fifty near-identical queries that drift from the
 * schema; this reaches them by name instead, and an unknown name fails loudly
 * on the first run rather than silently exporting nothing.
 */
type Delegate = { findMany: (args: { where: object }) => Promise<unknown[]> };

function delegate(model: string): Delegate {
  const found = (prisma as unknown as Record<string, Delegate | undefined>)[model];
  if (!found || typeof found.findMany !== "function") {
    throw new Error(`Export is configured for a table that does not exist: "${model}".`);
  }
  return found;
}

/** Replaces secrets and makes bytes and dates readable, recursively. */
function clean(value: unknown, keyName = ""): unknown {
  if (SECRET_COLUMN.test(keyName)) return "[redacted]";
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary, ${value.length} bytes]`;
  }
  // Prisma Decimal and anything else with a toJSON of its own.
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => clean(v));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clean(v, k)]),
    );
  }
  return value;
}

// ------------------------------------------------------------------ requesting

export interface ExportJobView {
  id: string;
  scope: string;
  status: string;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** Whether this row is downloadable right now. */
  downloadable: boolean;
  /** Only the requester may ask to see the passphrase again. */
  mine: boolean;
  requestedBy: string;
}

function view(
  job: {
    id: string;
    scope: string;
    status: string;
    sizeBytes: number | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
    expiresAt: Date | null;
    requestedById: string;
  },
  requesterName: string,
  ctx: AuthContext,
): ExportJobView {
  const live = job.expiresAt == null || job.expiresAt > new Date();
  return {
    id: job.id,
    scope: job.scope,
    status: job.status,
    sizeBytes: job.sizeBytes,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    downloadable: job.status === "READY" && live,
    mine: job.requestedById === ctx.userId,
    requestedBy: requesterName,
  };
}

/**
 * Builds an export and returns the passphrase — once.
 *
 * The passphrase is generated rather than chosen. People pick a password they
 * already use, and this one ends up written down next to a file containing every
 * salary in the company.
 */

/**
 * Taking your own data out is not a write.
 *
 * All four export entry points used `requireWrite`, which refuses whenever the
 * subscription has lapsed or a trial has ended — so the single moment a
 * customer most needs a copy of their records is the moment the product stops
 * giving it to them. Writing "your data is not held hostage" into the terms is
 * what surfaced it: the sentence was false, and the fix belongs in the code
 * rather than in the sentence.
 *
 * A superadmin acting as somebody in read-only support mode is still refused —
 * that restriction is about who is asking, not about whether the bill is paid.
 */
function requireExport(ctx: ExportContext): void {
  requirePermission(ctx, "org.data.export");
  if (ctx.readOnlyView) {
    requireWritable(ctx);
  }
}

export async function requestExport(
  ctx: AuthContext,
): Promise<{ job: ExportJobView; password: string }> {
  requireExport(ctx);
  const organizationId = ctx.organizationId;
  if (!organizationId) throw new ValidationError("Choose an organisation to export.");

  // Building one reads the whole database. Two people pressing the button
  // repeatedly should not be able to make that the server's whole job.
  await enforce("export", `export:${organizationId}`);

  const job = await prisma.dataExportJob.create({
    data: {
      organizationId,
      requestedById: ctx.userId,
      scope: "ORGANIZATION",
      status: "RUNNING",
    },
  });

  try {
    const password = generatePassphrase();
    const { archive, identifiersRevealed } = await buildArchive(organizationId, ctx);
    const locked = encryptArchive(archive, password);

    const key = buildKey(organizationId, "exports", ".hrms");
    await storage().put(key, locked, "application/octet-stream", {
      organizationId,
      kind: "exports",
    });

    const ready = await prisma.dataExportJob.update({
      where: { id: job.id },
      data: {
        status: "READY",
        fileKey: key,
        sizeBytes: locked.length,
        passwordCipher: encryptField(password),
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + LIFETIME_HOURS * 60 * 60 * 1000),
      },
    });

    await writeAudit(ctx, {
      action: "export.requested",
      entityType: "DataExportJob",
      entityId: job.id,
      after: { scope: "ORGANIZATION", sizeBytes: locked.length },
    });

    // Its own entry, and not folded into the one above.
    //
    // "Somebody took an export" and "somebody took a file holding every bank
    // account in the organisation" are different events, and the second is the
    // one an audit is read for. It names the fields and the number of people,
    // never a value.
    if (identifiersRevealed > 0) {
      await writeAudit(ctx, {
        action: "export.identifiers.included",
        entityType: "DataExportJob",
        entityId: job.id,
        after: {
          fields: Object.values(REVEALED_IDENTIFIERS.employee ?? {}),
          people: identifiersRevealed,
        },
      });
    }

    return { job: view(ready, ctx.name, ctx), password };
  } catch (error) {
    // A failed export must leave a row that says why, not a job stuck on
    // RUNNING that somebody waits on forever.
    const message = error instanceof Error ? error.message : "The export could not be built.";
    await prisma.dataExportJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: message.slice(0, 500) },
    });
    throw error;
  }
}

/**
 * The handful of encrypted columns an export reads back, decrypted.
 *
 * Added *beside* the redacted ones rather than replacing them, so
 * `panCipher: "[redacted]"` and `pan: "ABCDE1234F"` both appear: the shape of
 * the row still matches the schema, and it is obvious at a glance which fields
 * were decrypted on the way out.
 *
 * A value that cannot be decrypted is omitted, not guessed at. That happens
 * when a row predates the current key, and an empty field is a truer answer
 * than a string saying something went wrong.
 */
function reveal(model: string, row: unknown): Record<string, string> {
  if (!REVEALED_IDENTIFIERS[model]) return {};
  const out: Record<string, string> = {};
  for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
    const name = revealedAs(model, column);
    if (!name || typeof value !== "string" || value === "") continue;
    try {
      const plain = decryptOptional(value);
      if (plain) out[name] = plain;
    } catch {
      // Undecryptable. See above.
    }
  }
  return out;
}

/** Gathers every table and packs it. */
async function buildArchive(
  organizationId: string,
  ctx: AuthContext,
): Promise<{ archive: Buffer; identifiersRevealed: number }> {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!organization) throw new NotFoundError("That organisation");

  const entries: ZipEntry[] = [];
  const counts: Record<string, number> = {};

  const write = (name: string, value: unknown) => {
    entries.push({ name, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") });
  };

  write("organization.json", clean(organization));

  // How many rows carried a readable identifier, so the audit row can say what
  // this archive actually holds rather than what it was permitted to hold.
  let identifiersRevealed = 0;

  for (const table of TABLES) {
    const rows = await delegate(table.model).findMany({ where: table.where(organizationId) });
    counts[table.model] = rows.length;
    write(
      `tables/${table.model}.json`,
      rows.map((row) => {
        const cleaned = clean(row) as Record<string, unknown>;
        const revealed = reveal(table.model, row);
        if (Object.keys(revealed).length > 0) identifiersRevealed++;
        return { ...cleaned, ...revealed };
      }),
    );
  }

  const audit = await prisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: AUDIT_LIMIT,
  });
  counts.auditLog = audit.length;
  write("tables/auditLog.json", audit.map((row) => clean(row)));

  write("manifest.json", {
    product: BRAND.name,
    generatedAt: new Date().toISOString(),
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    requestedBy: { name: ctx.name, email: ctx.email, role: ctx.role },
    scope: "ORGANIZATION",
    tables: counts,
    readableIdentifiers: {
      fields: Object.values(REVEALED_IDENTIFIERS.employee ?? {}),
      rows: identifiersRevealed,
    },
    notes: [
      "Amounts are integer paise. Divide by 100 for rupees.",
      "Calendar dates are YYYY-MM-DD strings in the organisation's timezone.",
      "Encrypted columns are exported as \"[redacted]\", with one deliberate exception: an employee's PAN, UAN and bank details are decrypted into readable fields beside them, because a payroll migration cannot be done without them. Aadhaar carries its last four digits only.",
      "Authentication secrets, password hashes and face descriptors are redacted and have no readable form anywhere in this archive.",
      "Uploaded files are described by their metadata; the bytes themselves are not part of this archive.",
      audit.length === AUDIT_LIMIT
        ? `The audit log is capped at the ${AUDIT_LIMIT} most recent entries.`
        : "The audit log is complete.",
    ],
  });

  // Plain text, not JSON — this one is for a person opening the archive.
  entries.push({ name: "README.txt", data: Buffer.from(readme(organization.name), "utf8") });

  return { archive: createZip(entries), identifiersRevealed };
}

function readme(organizationName: string): string {
  return [
    `${organizationName} — data export`,
    "",
    "Every file is UTF-8 JSON. `manifest.json` lists what is here and how many",
    "rows each table holds; `organization.json` is the organisation itself; the",
    "`tables/` folder is one file per table, each an array of rows exactly as",
    "they are stored.",
    "",
    "Read this before you send this file anywhere:",
    "",
    ...IDENTIFIER_NOTICE.map((line) => (line === "" ? "" : `  ${line}`)),
    "",
    "What is not here, and why:",
    "",
    "  * Authentication secrets, password hashes and face descriptors. These are",
    "    encrypted in the database and are exported as \"[redacted]\". None of",
    "    them is a fact about a person that another system needs; each is a way",
    "    of becoming them.",
    "  * Blood group, which is encrypted beside the bank details and is left",
    "    redacted on purpose. It is health data, it is not needed to run",
    "    payroll, and it carries obligations the rest of this file does not.",
    "  * The contents of uploaded files. Documents, letters and payslips appear",
    "    as metadata rows; the bytes stay where they are.",
    "",
    "This archive was encrypted with a one-time password. If you are reading",
    "this, it has already been unlocked — treat what follows as you would the",
    "payroll it describes.",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ reading

export async function listExports(ctx: AuthContext): Promise<ExportJobView[]> {
  // Listing what exists is a read; only *requesting* one is refused to a
  // read-only support visit. The page threw for that visit otherwise.
  requirePermission(ctx, "org.data.export");

  const jobs = await prisma.dataExportJob.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const names = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: [...new Set(jobs.map((j) => j.requestedById))] } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );

  return jobs.map((job) => view(job, names.get(job.requestedById) ?? "Someone", ctx));
}

async function findJob(ctx: AuthContext, id: string) {
  const job = await prisma.dataExportJob.findFirst({
    // Scoped to the tenant, so a job id from another organisation is a 404 and
    // not a 403 — the same rule as everywhere else.
    where: { id, organizationId: ctx.organizationId },
  });
  if (!job) throw new NotFoundError("That export");
  return job;
}

/**
 * Shows the passphrase again, to the person who asked for the export.
 *
 * Storing it at all is a deliberate trade: an export nobody can open is waste,
 * and losing the password an hour after generating it is the most likely thing
 * to happen to it. What the encryption buys is that the file is useless on its
 * own — a copy of the storage, a stolen backup, a mis-sent download link. It was
 * never meant to defend against somebody already inside the account that asked
 * for it.
 */
export async function revealPassword(ctx: AuthContext, id: string): Promise<string> {
  requireExport(ctx);
  const job = await findJob(ctx, id);

  if (job.requestedById !== ctx.userId) {
    throw new NotFoundError("That export's password");
  }
  const password = decryptOptional(job.passwordCipher);
  if (!password) throw new ConflictError("This export has no password to show.");

  await writeAudit(ctx, {
    action: "export.requested",
    entityType: "DataExportJob",
    entityId: job.id,
    after: { passwordRevealed: true },
  });

  return password;
}

export interface ExportDownload {
  fileName: string;
  data: Buffer;
}

/**
 * Unlocks an export and hands back the plain ZIP.
 *
 * The passphrase has to be typed back rather than looked up, so that a session
 * left open on a shared machine is not by itself enough to walk away with the
 * whole company.
 */
export async function downloadExport(
  ctx: AuthContext,
  id: string,
  password: string,
): Promise<ExportDownload> {
  requireExport(ctx);
  await enforce("otpVerify", `export-download:${ctx.userId}`);

  const job = await findJob(ctx, id);
  if (job.status !== "READY" || !job.fileKey) {
    throw new ConflictError("That export is not ready to download.");
  }
  if (job.expiresAt && job.expiresAt <= new Date()) {
    throw new ConflictError("That export has expired. Request a new one.");
  }

  const stored = await storage().get(job.fileKey);
  if (!stored) throw new NotFoundError("That export's file");

  // Throws a plain "that password did not unlock the archive" on a mismatch.
  const archive = decryptArchive(stored.data, password.trim());

  await writeAudit(ctx, {
    action: "export.downloaded",
    entityType: "DataExportJob",
    entityId: job.id,
    after: { sizeBytes: archive.length },
  });

  const stamp = job.createdAt.toISOString().slice(0, 10);
  const slug = ctx.organization?.slug ?? "organisation";
  return { fileName: `${slug}-export-${stamp}.zip`, data: archive };
}

// ------------------------------------------------------------------ expiry

/**
 * Deletes the bytes of exports that have run out of time.
 *
 * The row stays, marked EXPIRED, because "an export was taken on the 3rd" is
 * itself a thing worth being able to answer later. Idempotent, so the
 * maintenance job can run it as often as it likes.
 */
export async function purgeExpiredExports(): Promise<{ expired: number; freedBytes: number }> {
  const due = await prisma.dataExportJob.findMany({
    where: { status: "READY", expiresAt: { lte: new Date() } },
    select: { id: true, fileKey: true, sizeBytes: true },
  });

  let freedBytes = 0;
  for (const job of due) {
    if (job.fileKey) {
      await storage().delete(job.fileKey);
      freedBytes += job.sizeBytes ?? 0;
    }
    await prisma.dataExportJob.update({
      where: { id: job.id },
      // The passphrase goes with the file. There is nothing left to unlock.
      data: { status: "EXPIRED", fileKey: null, passwordCipher: null },
    });
  }

  return { expired: due.length, freedBytes };
}
