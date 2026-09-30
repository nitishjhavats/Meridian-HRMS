-- Reporting lines keep their history.
--
-- `@@unique([employeeId, managerId, type])` forced re-appointing a previous
-- manager to reopen the old row, which collapsed "managed Jan-Mar, then again
-- from Sep" into "since Sep" -- and March's approval lost its manager. What
-- actually has to be unique is one *live* PRIMARY line per employee, which is
-- a partial index Prisma cannot express.
--
-- Safety check before this runs anywhere real:
--   SELECT "employeeId", count(*) FROM "ReportingRelationship"
--    WHERE "endDate" IS NULL AND "type" = 'PRIMARY'
--    GROUP BY 1 HAVING count(*) > 1;
-- The CREATE UNIQUE INDEX below fails if that returns anything.

-- DropIndex
DROP INDEX "ReportingRelationship_employeeId_managerId_type_key";

-- DropIndex
DROP INDEX "ReportingRelationship_organizationId_managerId_idx";

-- CreateIndex
CREATE INDEX "ReportingRelationship_organizationId_managerId_endDate_idx" ON "ReportingRelationship"("organizationId", "managerId", "endDate");

-- CreateIndex
CREATE INDEX "ReportingRelationship_organizationId_employeeId_endDate_idx" ON "ReportingRelationship"("organizationId", "employeeId", "endDate");

-- One live primary line per employee. Hand-written: Prisma has no syntax for a
-- partial index, so `prisma db pull` will not see this and a future
-- `migrate dev` will not recreate it. It is documented on the model.
CREATE UNIQUE INDEX "ReportingRelationship_one_live_primary"
  ON "ReportingRelationship" ("employeeId")
  WHERE "endDate" IS NULL AND "type" = 'PRIMARY';
