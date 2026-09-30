-- CreateTable
CREATE TABLE "DesignationLeaveAllocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "designationId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "annualAllocation" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignationLeaveAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignationLeaveAllocation_organizationId_idx" ON "DesignationLeaveAllocation"("organizationId");

-- CreateIndex
CREATE INDEX "DesignationLeaveAllocation_leaveTypeId_idx" ON "DesignationLeaveAllocation"("leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignationLeaveAllocation_designationId_leaveTypeId_key" ON "DesignationLeaveAllocation"("designationId", "leaveTypeId");

-- AddForeignKey
ALTER TABLE "DesignationLeaveAllocation" ADD CONSTRAINT "DesignationLeaveAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignationLeaveAllocation" ADD CONSTRAINT "DesignationLeaveAllocation_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignationLeaveAllocation" ADD CONSTRAINT "DesignationLeaveAllocation_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
