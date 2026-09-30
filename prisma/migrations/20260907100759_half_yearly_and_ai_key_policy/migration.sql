-- AlterEnum
ALTER TYPE "BillingCycle" ADD VALUE 'HALF_YEARLY';

-- AlterTable
ALTER TABLE "AiConfig" ADD COLUMN     "orgMayManageKey" BOOLEAN NOT NULL DEFAULT true;
