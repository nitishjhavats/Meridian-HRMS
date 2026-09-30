-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "employeeCodePrefix" VARCHAR(3) NOT NULL DEFAULT 'EMP';

-- Backfill, so no existing organisation is left calling itself "EMP".
--
-- The prefix already in use in the directory wins, because that is what is
-- printed on payslips and letters people already hold. Only when a directory
-- has no letter-prefixed code at all does the organisation's own name decide
-- it, and 'EMP' remains the last resort for an organisation with neither.
UPDATE "Organization" o
SET "employeeCodePrefix" = COALESCE(
  (
    SELECT UPPER(SUBSTRING(REGEXP_REPLACE(e."employeeCode", '[^A-Za-z]', '', 'g') FROM 1 FOR 3))
    FROM "Employee" e
    WHERE e."organizationId" = o."id"
      AND LENGTH(REGEXP_REPLACE(e."employeeCode", '[^A-Za-z]', '', 'g')) >= 3
    GROUP BY 1
    ORDER BY COUNT(*) DESC, 1 ASC
    LIMIT 1
  ),
  CASE
    WHEN LENGTH(REGEXP_REPLACE(o."name", '[^A-Za-z]', '', 'g')) >= 1
      THEN RPAD(UPPER(SUBSTRING(REGEXP_REPLACE(o."name", '[^A-Za-z]', '', 'g') FROM 1 FOR 3)), 3, 'X')
  END,
  'EMP'
);
