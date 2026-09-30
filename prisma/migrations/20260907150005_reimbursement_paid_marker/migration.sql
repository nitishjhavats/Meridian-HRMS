/*
  Warnings:

  - You are about to drop the column `payrollItemId` on the `ReimbursementClaim` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ReimbursementClaim" DROP CONSTRAINT "ReimbursementClaim_payrollItemId_fkey";

-- AlterTable
ALTER TABLE "ReimbursementClaim" DROP COLUMN "payrollItemId",
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paidInRunId" TEXT;

-- AddForeignKey
ALTER TABLE "ReimbursementClaim" ADD CONSTRAINT "ReimbursementClaim_paidInRunId_fkey" FOREIGN KEY ("paidInRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
