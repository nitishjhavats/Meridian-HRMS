-- DropIndex
DROP INDEX "DesignationReporting_organizationId_idx";

-- CreateIndex
CREATE INDEX "DesignationReporting_organizationId_designationId_idx" ON "DesignationReporting"("organizationId", "designationId");

-- AddForeignKey
ALTER TABLE "DesignationReporting" ADD CONSTRAINT "DesignationReporting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
