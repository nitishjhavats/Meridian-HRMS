-- Two additions, both nullable, neither changing an existing row.
--
-- `weekOffsPerMonth` lets a designation be owed a different number of rest days
-- from the organisation's payroll rule. Null keeps today's behaviour exactly.
ALTER TABLE "Designation" ADD COLUMN     "weekOffsPerMonth" INTEGER;

-- `LeaveCarryForwardRun` records each year-end run and the prior value of every
-- balance it touched. `runCarryForward` writes with `set` rather than
-- `increment` -- which is what makes a re-run harmless and an undo impossible,
-- because the old figure is gone the moment the new one lands. Keeping it here
-- is the whole of the undo.
CREATE TABLE "LeaveCarryForwardRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromYear" INTEGER NOT NULL,
    "toYear" INTEGER NOT NULL,
    "days" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "employees" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "ranById" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "LeaveCarryForwardRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeaveCarryForwardRun_organizationId_ranAt_idx" ON "LeaveCarryForwardRun"("organizationId", "ranAt");

ALTER TABLE "LeaveCarryForwardRun" ADD CONSTRAINT "LeaveCarryForwardRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
