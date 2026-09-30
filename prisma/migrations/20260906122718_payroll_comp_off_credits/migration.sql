-- AlterTable
ALTER TABLE "PayrollItem" ADD COLUMN     "compOffCreditedAt" TIMESTAMP(3),
ADD COLUMN     "compOffCredits" JSONB;
