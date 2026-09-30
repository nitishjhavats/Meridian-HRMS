-- AlterTable
ALTER TABLE "AttendanceEvent" ADD COLUMN     "faceMatchPassed" BOOLEAN,
ADD COLUMN     "faceMatchReason" TEXT,
ADD COLUMN     "faceMatchScore" DECIMAL(6,5),
ADD COLUMN     "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "faceConsentAt" TIMESTAMP(3),
ADD COLUMN     "faceDescriptorCipher" TEXT,
ADD COLUMN     "faceEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "faceEnrolledById" TEXT,
ADD COLUMN     "facePhotoKey" TEXT;

-- CreateIndex
CREATE INDEX "AttendanceEvent_organizationId_flaggedForReview_idx" ON "AttendanceEvent"("organizationId", "flaggedForReview");
