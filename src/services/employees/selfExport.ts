import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { decryptOptional, maskTail } from "@/lib/crypto/field";

/**
 * Everything this product holds about one person, for that person.
 *
 * The organisation-wide export already existed and is the wrong tool here: it
 * is scoped to a whole tenant, produces an encrypted archive with a passphrase
 * and a forty-eight-hour life, and is reachable only by an administrator. An
 * employee asking "what do you have about me" needs an answer they can read,
 * now, without asking anybody's permission — which is also what a data-principal
 * access request under the DPDP Act amounts to in practice.
 *
 * So this is a plain JSON download, assembled live, scoped by `ctx.employeeId`
 * and nothing else. There is no id parameter: the only record it can ever
 * produce is the caller's own.
 *
 * **Identifiers are masked, deliberately.** PAN, Aadhaar, bank account and UAN
 * are encrypted at rest precisely so a copy of the database is not a copy of
 * everybody's identity documents, and writing them in clear into a file that
 * then sits in a downloads folder undoes that. The last four digits are shown —
 * enough to confirm *which* number is held, which is what the request is really
 * asking — and the full values remain visible inside the app to the person they
 * belong to. The file says this about itself rather than leaving a gap.
 */

export interface SelfExport {
  generatedAt: string;
  about: string;
  employee: Record<string, unknown>;
  identifiers: Record<string, string | null>;
  attendance: unknown[];
  leave: unknown[];
  payslips: unknown[];
  documents: unknown[];
  letters: unknown[];
  faceVerification: Record<string, unknown>;
  signIns: unknown[];
  notes: string[];
}

const DAY = (value: Date | null | undefined) => value?.toISOString().slice(0, 10) ?? null;

export async function exportMyData(ctx: AuthContext): Promise<SelfExport> {
  requireOrg(ctx);
  if (!ctx.employeeId) {
    throw new ValidationError("Your login is not linked to an employee record.");
  }

  const employee = await prisma.employee.findFirstOrThrow({
    where: { id: ctx.employeeId, organizationId: ctx.organizationId! },
    include: {
      department: { select: { name: true } },
      designation: { select: { title: true } },
      workLocation: { select: { name: true } },
      shift: { select: { name: true, startTime: true, endTime: true } },
      organization: { select: { name: true } },
    },
  });

  const [attendance, leave, payslips, documents, letters, signIns] = await Promise.all([
    prisma.attendanceDay.findMany({
      where: { employeeId: employee.id },
      orderBy: { date: "desc" },
      select: {
        date: true,
        status: true,
        firstCheckInAt: true,
        lastCheckOutAt: true,
        workedMinutes: true,
        lateMinutes: true,
        overtimeMinutes: true,
      },
    }),
    prisma.leaveRequest.findMany({
      where: { employeeId: employee.id },
      orderBy: { startDate: "desc" },
      select: {
        startDate: true,
        endDate: true,
        totalDays: true,
        status: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.payrollItem.findMany({
      where: { employeeId: employee.id, run: { status: "LOCKED" } },
      orderBy: { createdAt: "desc" },
      select: {
        netPaise: true,
        earningsPaise: true,
        deductionsPaise: true,
        run: { select: { periodYear: true, periodMonth: true } },
      },
    }),
    prisma.employeeDocument.findMany({
      where: { employeeId: employee.id },
      select: { title: true, category: true, status: true, expiresOn: true, createdAt: true },
    }),
    prisma.letter.findMany({
      where: { employeeId: employee.id, status: "ISSUED" },
      select: { letterNumber: true, category: true, subject: true, issuedOn: true },
    }),
    // Their own sign-in history, which is also the audit trail of anybody who
    // tried to be them.
    prisma.loginEvent.findMany({
      where: { userId: employee.userId ?? "" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { createdAt: true, success: true, reason: true, ipAddress: true, deviceLabel: true },
    }),
  ]);

  const {
    panCipher,
    aadhaarCipher,
    bankAccountCipher,
    bankNameCipher,
    bankIfscCipher,
    uanCipher,
    pfNumberCipher,
    faceDescriptorCipher,
    facePhotoKey,
    photoKey,
    ...plain
  } = employee;
  void faceDescriptorCipher;

  const masked = (cipher: string | null) => {
    const value = decryptOptional(cipher);
    return value ? maskTail(value) : null;
  };

  await writeAudit(ctx, {
    action: "export.requested",
    entityType: "Employee",
    entityId: employee.id,
    metadata: { scope: "SELF" },
  });

  return {
    generatedAt: new Date().toISOString(),
    about: `${employee.firstName} ${employee.lastName ?? ""}`.trim(),
    employee: {
      ...plain,
      department: employee.department?.name ?? null,
      designation: employee.designation?.title ?? null,
      workLocation: employee.workLocation?.name ?? null,
      shift: employee.shift?.name ?? null,
      organization: employee.organization.name,
      hasProfilePhoto: Boolean(photoKey),
    },
    identifiers: {
      pan: masked(panCipher),
      aadhaar: masked(aadhaarCipher),
      bankName: decryptOptional(bankNameCipher) ?? null,
      bankAccount: masked(bankAccountCipher),
      bankIfsc: decryptOptional(bankIfscCipher) ?? null,
      uan: masked(uanCipher),
      pfNumber: masked(pfNumberCipher),
    },
    attendance: attendance.map((day) => ({ ...day, date: DAY(day.date) })),
    leave: leave.map((row) => ({
      ...row,
      startDate: DAY(row.startDate),
      endDate: DAY(row.endDate),
    })),
    payslips: payslips.map((item) => ({
      period: `${item.run.periodYear}-${String(item.run.periodMonth).padStart(2, "0")}`,
      grossPaise: item.earningsPaise,
      deductionsPaise: item.deductionsPaise,
      netPaise: item.netPaise,
    })),
    documents: documents.map((doc) => ({ ...doc, expiresOn: DAY(doc.expiresOn) })),
    letters: letters.map((letter) => ({ ...letter, issuedOn: DAY(letter.issuedOn) })),
    faceVerification: {
      enrolled: Boolean(facePhotoKey),
      enrolledAt: employee.faceEnrolledAt?.toISOString() ?? null,
      consentRecordedAt: employee.faceConsentAt?.toISOString() ?? null,
      note: "The numerical face template is encrypted and is never exported. Removing your reference photo deletes it.",
    },
    signIns,
    notes: [
      "This file was generated for you, from your own record, at the moment you asked for it.",
      "PAN, Aadhaar, bank account, UAN and PF numbers are shown as the last four digits only. They are encrypted at rest, and writing them in full into a downloadable file would undo that. The full values are visible to you inside the app.",
      "Attendance selfies, and the location and device details attached to each mark, are deleted automatically after the retention window and so may not appear for older dates.",
      "Amounts are in paise: divide by 100 for rupees.",
      "If something here is wrong, ask your employer to correct it — they hold this record, and this software processes it on their behalf.",
    ],
  };
}
