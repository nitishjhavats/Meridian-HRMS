-- How far each calendar has been filled with the default-on national holidays.
--
-- The three arrive on, arrive again every year, and can be switched off. Those
-- three facts only coexist because of this column: the maintenance job seeds
-- forward from it and records that it did, so it never revisits a year -- and a
-- holiday somebody deleted stays deleted rather than reappearing on the next run.
--
-- Backfilled to 2027 for every organisation that already has the 2027 rows, so
-- the job does not immediately re-add what round 7 already created.
ALTER TABLE "Organization" ADD COLUMN     "holidaysSeededThrough" INTEGER;

UPDATE "Organization" o
SET "holidaysSeededThrough" = 2027
WHERE EXISTS (
  SELECT 1 FROM "Holiday" h
  WHERE h."organizationId" = o.id
    AND h.name = 'Republic Day'
    AND EXTRACT(YEAR FROM h.date) = 2027
);
