-- CreateTable
CREATE TABLE "AttendancePinAuthority" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "designationId" TEXT,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "AttendancePinAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendancePinAuthority_organizationId_idx" ON "AttendancePinAuthority"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePinAuthority_organizationId_designationId_key" ON "AttendancePinAuthority"("organizationId", "designationId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePinAuthority_organizationId_employeeId_key" ON "AttendancePinAuthority"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "AttendancePinAuthority" ADD CONSTRAINT "AttendancePinAuthority_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePinAuthority" ADD CONSTRAINT "AttendancePinAuthority_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePinAuthority" ADD CONSTRAINT "AttendancePinAuthority_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
