-- CreateEnum
CREATE TYPE "KioskBypass" AS ENUM ('PIN', 'SUPERVISOR');

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'KIOSK';

-- AlterEnum
ALTER TYPE "SystemRole" ADD VALUE 'KIOSK';

-- AlterTable
ALTER TABLE "AttendanceEvent" ADD COLUMN     "bypassById" TEXT,
ADD COLUMN     "kioskBypass" "KioskBypass";

-- CreateTable
CREATE TABLE "KioskDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workLocationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "KioskDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePin" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "AttendancePin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KioskDevice_userId_key" ON "KioskDevice"("userId");

-- CreateIndex
CREATE INDEX "KioskDevice_organizationId_revokedAt_idx" ON "KioskDevice"("organizationId", "revokedAt");

-- CreateIndex
CREATE INDEX "AttendancePin_organizationId_employeeId_expiresAt_idx" ON "AttendancePin"("organizationId", "employeeId", "expiresAt");

-- CreateIndex
CREATE INDEX "AttendancePin_codeHash_idx" ON "AttendancePin"("codeHash");

-- AddForeignKey
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePin" ADD CONSTRAINT "AttendancePin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePin" ADD CONSTRAINT "AttendancePin_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
