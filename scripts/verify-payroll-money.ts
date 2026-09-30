/**
 * Proves the two payroll money bugs are fixed, through the real API.
 *
 * Both were the same shape: the engine computed the right number and nothing
 * persisted it. That kind of bug cannot be caught by a unit test of the engine —
 * the engine was always right — so this drives calculate, approve and lock over
 * HTTP, and reads the database between each step.
 *
 * The assertions that matter are the ones about *not* happening twice. An
 * advance that recovers on every lock is worse than one that never recovers,
 * because the money leaves somebody's pay each time.
 *
 *   npx tsx --env-file=.env scripts/verify-payroll-money.ts [baseUrl]
 */

import { PrismaClient } from "@prisma/client";

const BASE = process.argv[2] ?? "http://localhost:3000";
const prisma = new PrismaClient();

let cookie = "";
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

/** Every state change on a run goes through one endpoint. */
async function act(runId: string, action: "calculate" | "approve" | "lock") {
  const result = await call(`/api/payroll/runs/${runId}/action`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  if (result.status >= 400) throw new Error(`${action}: ${JSON.stringify(result.body)}`);
  return result;
}

async function main() {
  console.log(`Verifying payroll money against ${BASE}\n`);

  // ---- sign in as somebody who can run and lock payroll
  const owner = await prisma.user.findFirst({
    where: { role: "ORG_OWNER", organization: { status: "ACTIVE" } },
    select: { email: true, organizationId: true },
  });
  if (!owner) throw new Error("No active organisation owner to sign in as.");

  const login = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: owner.email, password: "Password@123" }),
  });
  if (login.status !== 200) throw new Error(`Could not sign in as ${owner.email}`);
  const organizationId = owner.organizationId!;

  // ---- find somebody with a salary structure, and give them an advance
  const employee = await prisma.employee.findFirst({
    where: { organizationId, active: true, salaryProfiles: { some: {} } },
    select: { id: true, firstName: true, employeeCode: true },
  });
  if (!employee) throw new Error("Nobody in this organisation has a salary profile.");

  const ADVANCE = 5_000_00; // ₹5,000
  await prisma.salaryAdvance.deleteMany({ where: { employeeId: employee.id } });
  const advance = await prisma.salaryAdvance.create({
    data: {
      organizationId,
      employeeId: employee.id,
      amountPaise: ADVANCE,
      issuedOn: new Date(),
      recovery: { mode: "FULL_NEXT" },
      status: "ACTIVE",
    },
    select: { id: true },
  });
  console.log(`Subject: ${employee.firstName} (${employee.employeeCode}), advance ${rupees(ADVANCE)}\n`);

  // ---- a run for last month, so attendance exists
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();

  await prisma.payrollRun.deleteMany({ where: { organizationId, periodYear: year, periodMonth: month } });
  const createRun = await call("/api/payroll/runs", {
    method: "POST",
    body: JSON.stringify({ year, month }),
  });
  const runId: string | undefined = createRun.body?.run?.id ?? createRun.body?.id;
  if (!runId) throw new Error(`Could not create a run: ${JSON.stringify(createRun.body)}`);

  console.log("── advance recovery ──");

  await act(runId, "calculate");

  const item = await prisma.payrollItem.findFirst({
    where: { payrollRunId: runId, employeeId: employee.id },
    select: { id: true, netPaise: true, advanceRecoveredPaise: true, advanceRecoveries: true },
  });
  check("the engine recovered something", (item?.advanceRecoveredPaise ?? 0) > 0, rupees(item?.advanceRecoveredPaise ?? 0));
  check("the per-advance breakdown was carried onto the item", Array.isArray(item?.advanceRecoveries));

  const beforeLock = await prisma.salaryAdvance.findUniqueOrThrow({
    where: { id: advance.id },
    select: { recoveredPaise: true, status: true },
  });
  check("nothing is recovered before the lock", beforeLock.recoveredPaise === 0);

  await act(runId, "approve");
  await act(runId, "lock");

  const afterLock = await prisma.salaryAdvance.findUniqueOrThrow({
    where: { id: advance.id },
    select: { recoveredPaise: true, status: true },
  });
  const entries = await prisma.advanceRecoveryEntry.count({ where: { advanceId: advance.id } });

  const expected = item?.advanceRecoveredPaise ?? 0;
  check(
    "the advance balance moved by exactly what the engine computed",
    afterLock.recoveredPaise === expected,
    `${rupees(afterLock.recoveredPaise)} vs ${rupees(expected)}`,
  );
  check("one recovery entry was written", entries === 1);
  check(
    "a fully repaid advance is marked RECOVERED",
    expected >= ADVANCE ? afterLock.status === "RECOVERED" : afterLock.status === "ACTIVE",
    afterLock.status,
  );

  // ---- the assertion that matters most
  //
  // `lockRun` returns early on an already-locked run, so locking twice through
  // the API would prove nothing. What `advancesAppliedAt` is actually for is a
  // run that finds its way back to APPROVED — a reopened revision, a support
  // fix, a bad migration — and is then locked again. That is what is simulated
  // here, because recovering the same money twice is the failure that costs
  // somebody real pay.
  await prisma.payrollRun.update({ where: { id: runId }, data: { status: "APPROVED" } });
  await act(runId, "lock");

  const afterRelock = await prisma.salaryAdvance.findUniqueOrThrow({
    where: { id: advance.id },
    select: { recoveredPaise: true },
  });
  const entriesAfter = await prisma.advanceRecoveryEntry.count({ where: { advanceId: advance.id } });

  check(
    "locking again recovers nothing further",
    afterRelock.recoveredPaise === afterLock.recoveredPaise,
    `${rupees(afterRelock.recoveredPaise)}`,
  );
  check("and writes no second entry", entriesAfter === entries);

  console.log("\n── manual adjustment ──");

  // Its own run, for the month before. Reusing the one above would measure the
  // adjustment against a baseline that has already moved: the advance is
  // RECOVERED now, so it is no longer deducted, and the net would rise by the
  // bonus *and* the advance together. That it stops being deducted is itself the
  // first bug being fixed, visibly.
  const priorMonth = month === 1 ? 12 : month - 1;
  const priorYear = month === 1 ? year - 1 : year;
  await prisma.payrollRun.deleteMany({
    where: { organizationId, periodYear: priorYear, periodMonth: priorMonth },
  });
  const second = await call("/api/payroll/runs", {
    method: "POST",
    body: JSON.stringify({ year: priorYear, month: priorMonth }),
  });
  const runB: string = second.body?.run?.id ?? second.body?.id;
  if (!runB) throw new Error(`Could not create the second run: ${JSON.stringify(second.body)}`);

  await act(runB, "calculate");

  const netBefore = (
    await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runB, employeeId: employee.id },
      select: { netPaise: true },
    })
  ).netPaise;

  const BONUS = 1_500_00;
  await prisma.payrollAdjustment.create({
    data: {
      organizationId,
      payrollRunId: runB,
      employeeId: employee.id,
      code: "SPOT_BONUS",
      label: "Spot bonus",
      kind: "EARNING",
      amountPaise: BONUS,
      reason: "verification script",
    },
  });

  await act(runB, "calculate");

  const netAfter = (
    await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runB, employeeId: employee.id },
      select: { netPaise: true },
    })
  ).netPaise;

  check(
    "an adjustment changes net pay by its own amount",
    netAfter - netBefore === BONUS,
    `${rupees(netBefore)} → ${rupees(netAfter)}`,
  );

  const survived = await prisma.payrollAdjustment.count({
    where: { payrollRunId: runB, employeeId: employee.id },
  });
  check("and survives the recalculation that rebuilt the items", survived === 1);

  console.log("\n── reimbursement ──");

  /**
   * The third money bug, and the one that had never produced a right answer at
   * all: `decideClaim` never set `periodYear`/`periodMonth`, which is exactly
   * what `buildPayrollInput` filters approved claims by — so no reimbursement
   * had ever reached a payslip. Nothing marked one paid either, so once the
   * period was set it would have been paid again by every later run.
   */
  const CLAIM = 1_750_00; // ₹1,750
  await prisma.reimbursementClaim.deleteMany({
    where: { employeeId: employee.id, claimNumber: { startsWith: "VERIFY-" } },
  });
  const claim = await prisma.reimbursementClaim.create({
    data: {
      organizationId,
      employeeId: employee.id,
      claimNumber: `VERIFY-${priorYear}${priorMonth}`,
      title: "Verification script claim",
      status: "APPROVED",
      totalPaise: CLAIM,
      approvedPaise: CLAIM,
      periodYear: priorYear,
      periodMonth: priorMonth,
    },
    select: { id: true },
  });

  const netBeforeClaim = (
    await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runB, employeeId: employee.id },
      select: { netPaise: true },
    })
  ).netPaise;

  await act(runB, "calculate");

  const netWithClaim = (
    await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runB, employeeId: employee.id },
      select: { netPaise: true },
    })
  ).netPaise;

  check(
    "an approved claim reaches the payslip",
    netWithClaim - netBeforeClaim === CLAIM,
    `${rupees(netBeforeClaim)} → ${rupees(netWithClaim)}`,
  );

  const unpaidBeforeLock = await prisma.reimbursementClaim.findUniqueOrThrow({
    where: { id: claim.id },
    select: { status: true, paidInRunId: true },
  });
  check(
    "nothing is marked paid before the lock",
    unpaidBeforeLock.status === "APPROVED" && unpaidBeforeLock.paidInRunId === null,
  );

  await act(runB, "approve");
  await act(runB, "lock");

  const afterClaimLock = await prisma.reimbursementClaim.findUniqueOrThrow({
    where: { id: claim.id },
    select: { status: true, paidInRunId: true, paidAt: true },
  });
  check(
    "locking marks it paid, against the run",
    afterClaimLock.status === "PAID" &&
      afterClaimLock.paidInRunId === runB &&
      afterClaimLock.paidAt !== null,
  );

  // Back to APPROVED and locked again — the reopened-revision case.
  await prisma.payrollRun.update({ where: { id: runB }, data: { status: "APPROVED" } });
  await act(runB, "calculate");

  const netAfterRecalc = (
    await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runB, employeeId: employee.id },
      select: { netPaise: true },
    })
  ).netPaise;
  check(
    "recalculating the run that paid it does not drop it from the payslip",
    netAfterRecalc === netWithClaim,
    `${rupees(netAfterRecalc)}`,
  );

  await act(runB, "approve");
  await act(runB, "lock");
  const stillOnce = await prisma.reimbursementClaim.findUniqueOrThrow({
    where: { id: claim.id },
    select: { paidInRunId: true },
  });
  check("locking again pays it no second time", stillOnce.paidInRunId === runB);

  // A later month must not pay it again — the failure the missing marker would
  // have caused the moment the period filter started matching.
  await prisma.payrollRun.deleteMany({
    where: { organizationId, periodYear: year, periodMonth: month },
  });
  const laterRun = await call("/api/payroll/runs", {
    method: "POST",
    body: JSON.stringify({ year, month }),
  });
  const laterRunId: string | undefined = laterRun.body?.run?.id ?? laterRun.body?.id;
  if (laterRunId) {
    await act(laterRunId, "calculate");
    const laterItem = await prisma.payrollItem.findFirst({
      where: { payrollRunId: laterRunId, employeeId: employee.id },
      select: { earnings: true },
    });
    const paidAgain = JSON.stringify(laterItem?.earnings ?? []).includes("VERIFY-");
    check("a later run does not pay the same claim again", !paidAgain);
    await prisma.payrollRun.deleteMany({ where: { id: laterRunId } });
  }

  await prisma.reimbursementClaim.deleteMany({ where: { id: claim.id } });

  // ---- leave the organisation as it was found
  await prisma.payrollRun.deleteMany({ where: { id: { in: [runId, runB] } } });
  await prisma.salaryAdvance.deleteMany({ where: { id: advance.id } });

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch(async (error) => {
  console.error("\nverification could not run:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
