-- The branch a new employee joins when nobody chooses one for them.
--
-- Every employee in production had workLocationId = NULL, because the employee
-- form lets the field be skipped and nothing filled it in. With no work
-- location the geofence is never evaluated at all, so attendance was markable
-- from anywhere. A default branch is what stops that recurring.

-- AlterTable
ALTER TABLE "WorkLocation" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "WorkLocation_organizationId_isPrimary_idx" ON "WorkLocation"("organizationId", "isPrimary");
