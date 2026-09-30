-- CreateEnum
CREATE TYPE "RecognitionUnit" AS ENUM ('RUPEES', 'COUNT', 'PERCENT', 'HOURS', 'POINTS');

-- CreateEnum
CREATE TYPE "RecognitionDirection" AS ENUM ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER');

-- CreateEnum
CREATE TYPE "RecognitionSource" AS ENUM ('MANUAL', 'PRESENT_DAYS', 'PUNCTUALITY', 'OVERTIME_HOURS', 'GOALS_COMPLETED');

-- CreateEnum
CREATE TYPE "RecognitionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RecognitionParameter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" "RecognitionUnit" NOT NULL DEFAULT 'COUNT',
    "direction" "RecognitionDirection" NOT NULL DEFAULT 'HIGHER_IS_BETTER',
    "weight" INTEGER NOT NULL DEFAULT 0,
    "source" "RecognitionSource" NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecognitionParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecognitionCycle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" "RecognitionStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "citation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecognitionCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecognitionScore" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "parameterId" TEXT NOT NULL,
    "rawValue" DECIMAL(18,4) NOT NULL,
    "normalised" DECIMAL(6,5) NOT NULL,

    CONSTRAINT "RecognitionScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecognitionAward" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "totalScore" DECIMAL(6,2) NOT NULL,
    "overriddenById" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecognitionAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecognitionParameter_organizationId_active_idx" ON "RecognitionParameter"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RecognitionParameter_organizationId_name_key" ON "RecognitionParameter"("organizationId", "name");

-- CreateIndex
CREATE INDEX "RecognitionCycle_organizationId_status_idx" ON "RecognitionCycle"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecognitionCycle_organizationId_periodYear_periodMonth_key" ON "RecognitionCycle"("organizationId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "RecognitionScore_cycleId_employeeId_idx" ON "RecognitionScore"("cycleId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecognitionScore_cycleId_employeeId_parameterId_key" ON "RecognitionScore"("cycleId", "employeeId", "parameterId");

-- CreateIndex
CREATE INDEX "RecognitionAward_organizationId_employeeId_idx" ON "RecognitionAward"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecognitionAward_cycleId_rank_key" ON "RecognitionAward"("cycleId", "rank");

-- AddForeignKey
ALTER TABLE "RecognitionParameter" ADD CONSTRAINT "RecognitionParameter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionCycle" ADD CONSTRAINT "RecognitionCycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionScore" ADD CONSTRAINT "RecognitionScore_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecognitionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionScore" ADD CONSTRAINT "RecognitionScore_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionScore" ADD CONSTRAINT "RecognitionScore_parameterId_fkey" FOREIGN KEY ("parameterId") REFERENCES "RecognitionParameter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionAward" ADD CONSTRAINT "RecognitionAward_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionAward" ADD CONSTRAINT "RecognitionAward_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecognitionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecognitionAward" ADD CONSTRAINT "RecognitionAward_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
