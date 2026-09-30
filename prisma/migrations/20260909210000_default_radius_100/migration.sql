-- The shipped geofence radius, 150 m -> 100 m.
--
-- A hundred metres is a building and its car park; a hundred and fifty reaches
-- the far side of the road and, on a market street, two doors down.
--
-- The column default only, so no existing fence moves. Tightening a live fence
-- refuses people who were accepted yesterday, and that is a decision for the
-- organisation holding the screen rather than a side effect of a deploy.
ALTER TABLE "WorkLocation" ALTER COLUMN "radiusMeters" SET DEFAULT 100;
