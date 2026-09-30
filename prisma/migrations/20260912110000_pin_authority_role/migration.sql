-- A whole login role may be named on the PIN authority screen.
--
-- The screen granted by designation or by person. "Every HR manager may
-- issue a PIN" was not sayable, so an owner who meant exactly that had to
-- name each of them. Owner and Admin are never rows: they hold
-- attendance.pin.issue from the role bundle.
ALTER TABLE "AttendancePinAuthority" ADD COLUMN "role" "SystemRole";

CREATE UNIQUE INDEX "AttendancePinAuthority_organizationId_role_key"
  ON "AttendancePinAuthority"("organizationId", "role");
