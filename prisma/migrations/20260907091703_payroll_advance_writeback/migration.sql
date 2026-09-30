-- AlterTable
ALTER TABLE "PayrollItem" ADD COLUMN     "advanceRecoveries" JSONB,
ADD COLUMN     "advancesAppliedAt" TIMESTAMP(3);
