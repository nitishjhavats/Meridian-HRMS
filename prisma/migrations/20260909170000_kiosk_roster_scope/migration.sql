-- Who a reception device lists.
--
-- The default is ORGANISATION, which is what every existing device already
-- does. Narrowing on deploy would have made people disappear from reception
-- screens overnight: one live device stands at "Nx one" and one of the three
-- employees on its roster is registered at a different location entirely, so a
-- WORK_LOCATION default would have removed her from the only screen she can
-- reach, with nothing on that screen to say why.
--
-- New devices are asked the question and the form offers WORK_LOCATION first.
CREATE TYPE "KioskRosterScope" AS ENUM ('ORGANISATION', 'WORK_LOCATION');

ALTER TABLE "KioskDevice"
  ADD COLUMN "rosterScope" "KioskRosterScope" NOT NULL DEFAULT 'ORGANISATION';
