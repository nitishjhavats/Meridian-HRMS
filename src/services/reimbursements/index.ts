import type { ClaimStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import { DEFAULT_CODE_PREFIX, normaliseCodePrefix } from "@/domain/employees/code";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { ingestUpload, storage } from "@/lib/storage";
import { formatPaise } from "@/domain/money";
import { type DateOnly, todayInZone } from "@/domain/date";

/**
 * Expense reimbursement.
 *
 * A claim is a container of line items, each with its own bill. It is a draft
 * while the person is still adding receipts, and only becomes visible to an
 * approver when they submit it — half-entered claims arriving in somebody's
 * queue is how approval queues stop being read.
 *
 * The approver may approve a *lesser* amount than claimed. That is the normal
 * case in practice ("the taxi yes, the dinner no"), and a system that only
 * offers approve-or-reject forces the whole claim to be rejected and re-entered.
 */

export const EXPENSE_CATEGORIES = [
  "TRAVEL",
  "ACCOMMODATION",
  "MEALS",
  "FUEL",
  "TELECOM",
  "INTERNET",
  "TRAINING",
  "MEDICAL",
  "OFFICE_SUPPLIES",
  "CLIENT_ENTERTAINMENT",
  "OTHER",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  TRAVEL: "Travel",
  ACCOMMODATION: "Accommodation",
  MEALS: "Meals",
  FUEL: "Fuel",
  TELECOM: "Phone",
  INTERNET: "Internet",
  TRAINING: "Training",
  MEDICAL: "Medical",
  OFFICE_SUPPLIES: "Office supplies",
  CLIENT_ENTERTAINMENT: "Client entertainment",
  OTHER: "Other",
};

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/**
 * Sequential per organisation and year, so a claim can be quoted in an email.
 *
 * Led by the organisation's own prefix, like every other number it issues. It
 * was `EXP/2026/0001` for everybody, so two organisations on this instance had
 * the same claim number and an email quoting one was ambiguous.
 *
 * Claims already raised keep their numbers: the series is matched by prefix, so
 * the new shape counts from its own start.
 */
async function nextClaimNumber(organizationId: string, year: number): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { employeeCodePrefix: true },
  });
  const mark = normaliseCodePrefix(org?.employeeCodePrefix ?? DEFAULT_CODE_PREFIX);
  const prefix = `${mark}/EXP/${year}/`;
  const last = await prisma.reimbursementClaim.findFirst({
    where: { organizationId, claimNumber: { startsWith: prefix } },
    orderBy: { claimNumber: "desc" },
    select: { claimNumber: true },
  });
  const n = last ? Number(last.claimNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

// ------------------------------------------------------------------ reading

export interface ClaimItemRow {
  id: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  spentOn: DateOnly;
  amountPaise: number;
  fileUrl: string | null;
  fileName: string | null;
}

export interface ClaimRow {
  id: string;
  claimNumber: string;
  title: string;
  status: ClaimStatus;
  totalPaise: number;
  approvedPaise: number;
  submittedAt: string | null;
  reviewNote: string | null;
  paidWithPayroll: boolean;
  employee: { id: string; name: string; code: string };
  items: ClaimItemRow[];
  /** Whether the viewer may act on it. */
  isMine: boolean;
}

export async function listClaims(
  ctx: AuthContext,
  filters: { status?: ClaimStatus; mine?: boolean } = {},
): Promise<ClaimRow[]> {
  requireOrg(ctx);

  const where: Record<string, unknown> = { organizationId: ctx.organizationId };

  // A discarded draft is a tombstone (see `discardClaim`); neither list shows it.
  if (filters.mine || !ctx.permissions.has("reimbursement.approve")) {
    // Somebody who can only claim sees their own, drafts included.
    where.employeeId = ctx.employeeId ?? "";
    where.status = filters.status ?? { not: "CANCELLED" };
  } else {
    const visible = await visibleEmployeeIds(ctx, "employee.read");
    where.OR = [
      {
        ...(visible !== null ? { employeeId: { in: visible } } : {}),
        // An approver has no business reading anybody else's half-written drafts.
        status: filters.status ?? { notIn: ["DRAFT", "CANCELLED"] },
      },
      // ...but is a claimant too. A team lead's own draft that the list hid
      // could be neither added to, sent, nor discarded, and every press of
      // "Start a claim" made another one.
      ...(filters.status ? [] : [{ employeeId: ctx.employeeId ?? "", status: "DRAFT" as const }]),
    ];
  }
  if (filters.status) where.status = filters.status;

  const claims = await prisma.reimbursementClaim.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      claimNumber: true,
      title: true,
      status: true,
      totalPaise: true,
      approvedPaise: true,
      submittedAt: true,
      reviewNote: true,
      paidInRunId: true,
      paidAt: true,
      employeeId: true,
      employee: {
        select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
      },
      items: {
        orderBy: { spentOn: "asc" },
        select: {
          id: true,
          category: true,
          description: true,
          spentOn: true,
          amountPaise: true,
          fileKey: true,
          fileName: true,
        },
      },
    },
  });

  return claims.map((c) => ({
    id: c.id,
    claimNumber: c.claimNumber,
    title: c.title,
    status: c.status,
    totalPaise: c.totalPaise,
    approvedPaise: c.approvedPaise,
    submittedAt: c.submittedAt?.toISOString() ?? null,
    reviewNote: c.reviewNote,
    paidWithPayroll: c.paidInRunId != null,
    employee: {
      id: c.employee.id,
      name: employeeName(c.employee, "—"),
      code: c.employee.employeeCode,
    },
    items: c.items.map((i) => ({
      id: i.id,
      category: i.category,
      categoryLabel: CATEGORY_LABELS[i.category] ?? i.category,
      description: i.description,
      spentOn: toDateOnly(i.spentOn),
      amountPaise: i.amountPaise,
      fileUrl: i.fileKey ? `/api/files/${i.fileKey}` : null,
      fileName: i.fileName,
    })),
    isMine: c.employeeId === ctx.employeeId,
  }));
}

// ------------------------------------------------------------------ writing

export async function createClaim(ctx: AuthContext, title: string) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.claim", "reimbursements");

  const employeeId = ctx.employeeId;
  if (!employeeId) throw new ValidationError("Your login is not linked to an employee record.");

  const year = Number(todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata").slice(0, 4));

  const claim = await prisma.reimbursementClaim.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId,
      claimNumber: await nextClaimNumber(ctx.organizationId, year),
      title: title.trim() || "Expense claim",
      status: "DRAFT",
    },
  });

  return { id: claim.id, claimNumber: claim.claimNumber };
}

/** Loads a claim the caller is allowed to change, and checks it is still open. */
async function ownDraft(ctx: AuthContext, claimId: string) {
  const claim = await prisma.reimbursementClaim.findFirst({
    where: { id: claimId, organizationId: ctx.organizationId! },
    select: { id: true, employeeId: true, status: true, claimNumber: true },
  });
  if (!claim) throw new NotFoundError("That claim");
  if (claim.employeeId !== ctx.employeeId) {
    throw new ForbiddenError("You can only change your own claims.");
  }
  if (claim.status !== "DRAFT") {
    throw new ConflictError("A claim that has been submitted cannot be edited.");
  }
  return claim;
}

export interface AddItemInput {
  category: string;
  description?: string;
  spentOn: DateOnly;
  amountPaise: number;
}

export async function addItem(
  ctx: AuthContext,
  claimId: string,
  input: AddItemInput,
  bill?: { data: Buffer; fileName: string; mimeType: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.claim", "reimbursements");
  await ownDraft(ctx, claimId);

  if (input.amountPaise <= 0) throw new ValidationError("An expense needs an amount.");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  if (input.spentOn > today) {
    throw new ValidationError("You cannot claim for a date in the future.");
  }

  const stored = bill
    ? await ingestUpload(bill, { organizationId: ctx.organizationId, kind: "documents" })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.reimbursementItem.create({
      data: {
        claimId,
        category: input.category,
        description: input.description?.trim() || null,
        spentOn: toDate(input.spentOn),
        amountPaise: input.amountPaise,
        fileKey: stored?.key ?? null,
        fileName: bill?.fileName ?? null,
      },
    });

    // The total is derived from the items, never accumulated — an increment
    // that drifts from its lines is a number nobody can reconcile.
    const sum = await tx.reimbursementItem.aggregate({
      where: { claimId },
      _sum: { amountPaise: true },
    });
    await tx.reimbursementClaim.update({
      where: { id: claimId },
      data: { totalPaise: sum._sum.amountPaise ?? 0 },
    });
  });

  return { claimId };
}

export async function removeItem(ctx: AuthContext, claimId: string, itemId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.claim", "reimbursements");
  await ownDraft(ctx, claimId);

  await prisma.$transaction(async (tx) => {
    await tx.reimbursementItem.deleteMany({ where: { id: itemId, claimId } });
    const sum = await tx.reimbursementItem.aggregate({
      where: { claimId },
      _sum: { amountPaise: true },
    });
    await tx.reimbursementClaim.update({
      where: { id: claimId },
      data: { totalPaise: sum._sum.amountPaise ?? 0 },
    });
  });

  return { claimId };
}

/**
 * Throws a draft away.
 *
 * "Start a claim" creates the row before a single receipt is attached, so a
 * change of mind -- or a double press -- left an empty draft in "Your claims"
 * for good: nothing on the screen or in the API removed it, and "Send for
 * approval" stayed disabled beside "No expenses added yet".
 *
 * Marked CANCELLED and emptied, not deleted. The claim number is issued the
 * moment a draft starts and `nextClaimNumber` is the highest one plus one, so
 * deleting the newest draft would hand its number to the next claim -- and
 * the audit log would then say 0007 was discarded with a bill deleted, and
 * also approved and paid. The tombstone keeps the number; both lists leave
 * CANCELLED out, so nobody sees the shell.
 *
 * Only a DRAFT: once submitted it is somebody else's to decide. `ownDraft`
 * says so, and the status flip below says it again with a condition, because
 * "Send for approval" and "Discard" are live on the screen at the same
 * moment and a submit that lands between the two must not be thrown away.
 */
export async function discardClaim(ctx: AuthContext, claimId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.claim", "reimbursements");
  const claim = await ownDraft(ctx, claimId);

  const bills = await prisma.reimbursementItem.findMany({
    where: { claimId, fileKey: { not: null } },
    select: { fileKey: true },
  });

  const flipped = await prisma.reimbursementClaim.updateMany({
    where: { id: claimId, employeeId: ctx.employeeId ?? "", status: "DRAFT" },
    data: { status: "CANCELLED", totalPaise: 0 },
  });
  if (flipped.count === 0) {
    throw new ConflictError("This claim has already been sent for approval.");
  }

  // The bills go before their rows, as the documents service does: a row
  // without its blob is recoverable confusion, a blob without its row is an
  // orphan nobody will ever find again.
  const store = storage();
  for (const bill of bills) {
    if (bill.fileKey) await store.delete(bill.fileKey).catch(() => undefined);
  }
  await prisma.reimbursementItem.deleteMany({ where: { claimId } });

  // Nobody else saw the draft, but bills were deleted from storage, and a
  // deletion of files is worth one line somewhere. The facts sit on the
  // `after` side because that is the side the audit table reads.
  await writeAudit(ctx, {
    action: "reimbursement.discarded",
    entityType: "ReimbursementClaim",
    entityId: claimId,
    before: { claimNumber: claim.claimNumber, status: "DRAFT" },
    after: { claimNumber: claim.claimNumber, status: "CANCELLED", billsDeleted: bills.length },
  });

  return { id: claimId, discarded: true as const };
}

export async function submitClaim(ctx: AuthContext, claimId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.claim", "reimbursements");

  const claim = await ownDraft(ctx, claimId);
  const items = await prisma.reimbursementItem.count({ where: { claimId } });
  if (items === 0) throw new ValidationError("Add at least one expense before submitting.");

  const updated = await prisma.reimbursementClaim.update({
    where: { id: claimId },
    data: { status: "SUBMITTED", submittedAt: new Date() },
    select: { claimNumber: true, totalPaise: true },
  });

  await writeAudit(ctx, {
    action: "reimbursement.submitted",
    entityType: "ReimbursementClaim",
    entityId: claimId,
    after: { claimNumber: updated.claimNumber, totalPaise: updated.totalPaise, items },
  });

  await notify.toOrgRoles(ctx.organizationId, ["TEAM_LEAD", "HR_MANAGER", "ADMIN", "ORG_OWNER"], {
    type: "reimbursement.submitted",
    title: "Expense claim to review",
    body: `${ctx.name ?? "An employee"} claimed ${formatPaise(updated.totalPaise)}.`,
    link: "/reimbursements",
  });

  void claim;
  return { id: claimId, status: "SUBMITTED" as const };
}

// ------------------------------------------------------------------ deciding

export async function decideClaim(
  ctx: AuthContext,
  claimId: string,
  decision: "APPROVED" | "REJECTED",
  options: { approvedPaise?: number; note?: string } = {},
) {
  requireOrg(ctx);
  requireWrite(ctx, "reimbursement.approve", "reimbursements");

  const claim = await prisma.reimbursementClaim.findFirst({
    where: { id: claimId, organizationId: ctx.organizationId },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      totalPaise: true,
      employeeId: true,
      employee: { select: { userId: true } },
    },
  });
  if (!claim) throw new NotFoundError("That claim");
  if (claim.status !== "SUBMITTED") {
    throw new ConflictError(`That claim is already ${claim.status.toLowerCase()}.`);
  }
  if (claim.employeeId === ctx.employeeId) {
    throw new ValidationError("You cannot approve your own expense claim.");
  }

  // Approving less than claimed is normal; approving more is not.
  const approved =
    decision === "APPROVED" ? (options.approvedPaise ?? claim.totalPaise) : 0;
  if (approved > claim.totalPaise) {
    throw new ValidationError(
      `You cannot approve more than the ${formatPaise(claim.totalPaise)} claimed.`,
    );
  }
  if (decision === "APPROVED" && approved <= 0) {
    throw new ValidationError("Approving nothing is a rejection — use reject instead.");
  }
  if (decision === "REJECTED" && !options.note?.trim()) {
    throw new ValidationError("Say why the claim was not accepted.");
  }

  /**
   * The payroll month this rides with.
   *
   * It was never set. `buildPayrollInput` selects approved claims by
   * `periodYear`/`periodMonth`, and the only code that ever wrote those columns
   * was `attachToPayroll`, which no route or screen has ever called — so the
   * filter matched nothing, no reimbursement has ever reached a payslip, and
   * the notification below has been promising otherwise the whole time.
   *
   * Stamped at approval with the current month. Payroll picks up everything
   * approved on or before the month being run, so a claim approved after that
   * month is locked simply rides with the next one instead of vanishing.
   */
  const approvedOn = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const [approvedYear, approvedMonth] = approvedOn.split("-").map(Number) as [number, number];

  await prisma.reimbursementClaim.update({
    where: { id: claimId },
    data: {
      status: decision,
      approvedPaise: approved,
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: options.note?.trim() || null,
      ...(decision === "APPROVED"
        ? { periodYear: approvedYear, periodMonth: approvedMonth }
        : { periodYear: null, periodMonth: null }),
    },
  });

  await writeAudit(ctx, {
    action: decision === "APPROVED" ? "reimbursement.approved" : "reimbursement.rejected",
    entityType: "ReimbursementClaim",
    entityId: claimId,
    before: { status: "SUBMITTED", totalPaise: claim.totalPaise },
    after: { status: decision, approvedPaise: approved, note: options.note?.trim() || null },
  });

  if (claim.employee.userId) {
    await notify.toUser(claim.employee.userId, {
      type: decision === "APPROVED" ? "reimbursement.approved" : "reimbursement.rejected",
      title: decision === "APPROVED" ? "Expense claim approved" : "Expense claim rejected",
      body:
        decision === "APPROVED"
          ? approved < claim.totalPaise
            ? `${formatPaise(approved)} of ${formatPaise(claim.totalPaise)} approved. ${options.note ?? ""}`.trim()
            : `${formatPaise(approved)} approved. It will be paid with your salary.`
          : `${claim.claimNumber} was not accepted. ${options.note ?? ""}`.trim(),
      link: "/reimbursements",
    });
  }

  return { id: claimId, status: decision, approvedPaise: approved };
}

// ------------------------------------------------------------------ payout

/**
 * Every approved claim still waiting to be paid, whatever month it is for.
 *
 * Deliberately unbounded by period, and the docstring used to say "for a
 * payroll month" while the query filtered no month at all. This feeds the
 * approver's own screen, where the question is "what does this organisation
 * still owe people" — a claim filed in January and never picked up by a run is
 * exactly the one worth seeing, and a period filter would hide it.
 *
 * The predicate that decides which claims ride a *specific* run is a different
 * question with a different answer, and lives in one place:
 * `claimsRidingRun` in `payroll/inputBuilder.ts`. Do not make this one call it.
 *
 * Reimbursement is not salary — it is money already spent being returned — so
 * it rides along with payroll rather than being prorated by attendance.
 */
export async function pendingPayouts(ctx: AuthContext) {
  requireOrg(ctx);
  // A read. `requireWrite` here refused the whole page the moment a trial
  // ended or a payment lapsed -- under a banner that had promised read-only.
  requirePermission(ctx, "reimbursement.approve");
  requireModule(ctx, "reimbursements");

  const claims = await prisma.reimbursementClaim.findMany({
    where: { organizationId: ctx.organizationId, status: "APPROVED", paidInRunId: null },
    orderBy: { reviewedAt: "asc" },
    select: {
      id: true,
      claimNumber: true,
      approvedPaise: true,
      employeeId: true,
      periodYear: true,
      periodMonth: true,
      employee: {
        select: { employeeCode: true, firstName: true, lastName: true },
      },
    },
  });

  return claims.map((c) => ({
    id: c.id,
    claimNumber: c.claimNumber,
    approvedPaise: c.approvedPaise,
    employeeId: c.employeeId,
    // Read off the employee, not their login: plenty of people have a record
    // and no account, and this used to render "—" for every one of them.
    employeeName: [c.employee.firstName, c.employee.lastName].filter(Boolean).join(" "),
    employeeCode: c.employee.employeeCode,
    /** The payroll month it will ride with, set when it was approved. */
    period:
      c.periodYear && c.periodMonth
        ? `${c.periodYear}-${String(c.periodMonth).padStart(2, "0")}`
        : null,
  }));
}

/**
 * `attachToPayroll` used to live here, and was called from nowhere.
 *
 * It was the only writer of `payrollItemId`, the only thing that would ever have
 * marked a claim paid — and the column it wrote hung off a payroll *item*, which
 * recalculating a run deletes and rebuilds. Even if something had called it, the
 * marker would have been erased by the next calculation. That is the same defect
 * that had to be fixed for `PayrollAdjustment`.
 *
 * Marking a claim paid now happens in `lockRun`, beside the advance write-back
 * and the comp-off credit, against the run rather than the item.
 */
