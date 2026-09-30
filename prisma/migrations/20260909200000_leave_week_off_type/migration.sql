-- The weekly rest day, as a leave type somebody can request.
--
-- A day booked against a type carrying this becomes WEEK_OFF on the attendance
-- record rather than PAID_LEAVE, which is what links it to the payroll rule
-- that counts rest days and pays for the ones nobody got to take.
ALTER TABLE "LeaveType" ADD COLUMN     "isWeekOff" BOOLEAN NOT NULL DEFAULT false;
