-- Week offs: a personal layer, and the on-demand day named and capped.
--
-- Three numbers with three meanings lived on three screens, and the leave
-- type seeded as "Week Off" was already an on-demand extra rest day in
-- everything but name: a leave can never be booked on a pattern rest day, so
-- the four a month it granted were always on top of the pattern. Now it says
-- so, and it is capped per month -- a bank of rest days could be spent eight
-- in one month before this.
ALTER TABLE "Employee" ADD COLUMN "weeklyOffConfig" JSONB;
ALTER TABLE "Employee" ADD COLUMN "weekOffsPerMonth" INTEGER;
ALTER TABLE "LeaveType" ADD COLUMN "maxPerMonth" INTEGER;

-- The live organisations' seeded type: the name it always deserved, and the
-- cap the owner asked for (the monthly accrual it already had). Reversible on
-- the leave-types screen.
-- The cap only where a monthly figure exists; a type an administrator moved
-- to annual accrual keeps no cap rather than getting one of a single day.
UPDATE "LeaveType"
SET "maxPerMonth" = ROUND("monthlyAccrual")::int
WHERE "isWeekOff" = true AND "maxPerMonth" IS NULL
  AND "accrualMode" = 'MONTHLY' AND "monthlyAccrual" >= 1;

-- Only the seeded name is replaced; a name an administrator chose stays.
UPDATE "LeaveType"
SET "name" = 'On-demand Week Off'
WHERE "isWeekOff" = true AND "name" = 'Week Off';
