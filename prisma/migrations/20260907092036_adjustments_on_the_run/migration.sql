/*
  Warnings:

  - You are about to drop the column `payrollItemId` on the `PayrollAdjustment` table. All the data in the column will be lost.
  - Added the required column `employeeId` to the `PayrollAdjustment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payrollRunId` to the `PayrollAdjustment` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "PayrollAdjustment" DROP CONSTRAINT "PayrollAdjustment_payrollItemId_fkey";

-- DropIndex
DROP INDEX "PayrollAdjustment_payrollItemId_idx";

-- AlterTable
ALTER TABLE "PayrollAdjustment" DROP COLUMN "payrollItemId",
ADD COLUMN     "employeeId" TEXT NOT NULL,
ADD COLUMN     "payrollRunId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "PayrollAdjustment_payrollRunId_employeeId_idx" ON "PayrollAdjustment"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_organizationId_idx" ON "PayrollAdjustment"("organizationId");

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
