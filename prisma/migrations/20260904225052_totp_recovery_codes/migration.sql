-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
