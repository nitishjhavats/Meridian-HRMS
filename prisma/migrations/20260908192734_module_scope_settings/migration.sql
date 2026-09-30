-- CreateTable
CREATE TABLE "DesignationModuleSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "designationId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignationModuleSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModuleSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserModuleSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignationModuleSetting_organizationId_idx" ON "DesignationModuleSetting"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignationModuleSetting_designationId_moduleKey_key" ON "DesignationModuleSetting"("designationId", "moduleKey");

-- CreateIndex
CREATE INDEX "UserModuleSetting_organizationId_idx" ON "UserModuleSetting"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "UserModuleSetting_userId_moduleKey_key" ON "UserModuleSetting"("userId", "moduleKey");

-- AddForeignKey
ALTER TABLE "DesignationModuleSetting" ADD CONSTRAINT "DesignationModuleSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignationModuleSetting" ADD CONSTRAINT "DesignationModuleSetting_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModuleSetting" ADD CONSTRAINT "UserModuleSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserModuleSetting" ADD CONSTRAINT "UserModuleSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
