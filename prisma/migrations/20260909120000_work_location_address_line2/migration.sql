-- A branch address in two lines.
--
-- The reception screen prints where the device stands, and a single free-text
-- box wrapped onto a second line and pushed the kiosk header taller every time
-- somebody typed a full address into it. Additive and nullable: every existing
-- row keeps whatever is in `address` as its first line.
ALTER TABLE "WorkLocation" ADD COLUMN     "addressLine2" TEXT;
