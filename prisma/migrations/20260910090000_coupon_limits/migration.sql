-- Three more questions a coupon can answer.
--
-- `maxPerOrganisation` is the per-buyer limit. `maxRedemptions` was the total
-- across everybody, so one organisation could spend a hundred-use launch
-- coupon entirely on its own renewals and nobody else would ever see it.
--
-- `firstPurchaseOnly` is for the offer that brings somebody in: it should not
-- keep paying out every time they renew.
--
-- `listed` decides whether the coupon appears in the list at checkout. It
-- defaults to FALSE, which is what every existing coupon keeps: a code emailed
-- to one customer must not appear in a dropdown for everybody else the moment
-- this deploys. Publishing one is a decision somebody takes.
ALTER TABLE "Coupon"
  ADD COLUMN "maxPerOrganisation" INTEGER,
  ADD COLUMN "firstPurchaseOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false;
