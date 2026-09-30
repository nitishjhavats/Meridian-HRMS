import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getAttendanceSettings } from "@/services/attendance/settings";
import { PageHeader } from "@/components/ui/stat";
import { AttendanceSettingsForm } from "./AttendanceSettingsForm";
import { KioskDevices } from "./KioskDevices";
import { PinAuthority } from "./PinAuthority";

export const metadata = { title: "Attendance rules" };
export const dynamic = "force-dynamic";

/**
 * Guarded on read, not write.
 *
 * An HR manager who can see attendance but not change the rules still benefits
 * from being able to read them — "why did that day come out as a half day" is
 * answered here. The form is disabled for them, and the write path guards itself
 * independently.
 */
export default async function AttendanceSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "org.settings.read",
    module: "attendance",
    what: "attendance rules",
  });
  if (denied) return denied;

  const settings = await getAttendanceSettings(ctx);
  const canWrite = ctx.permissions.has("attendance.settings.manage");

  return (
    <>
      <Link
        href="/settings"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Settings
      </Link>

      <PageHeader
        title="Attendance rules"
        description="When somebody counts as late, what earns a full day, and where attendance may be marked."
      />

      <AttendanceSettingsForm
        initial={{
          policy: settings.policy,
          faceMatch: settings.faceMatch,
          shiftMinutes: settings.shiftMinutes,
          effectiveFrom: settings.effectiveFrom,
          withoutWorkLocation: settings.withoutWorkLocation,
        }}
        canWrite={canWrite}
      />

      {/* Below the rules, because a device is only useful once the office-device
          rule above is switched on. */}
      <div className="mt-4">
        <KioskDevices canWrite={canWrite} />

      {/* And below the device, because a PIN is what somebody uses when the
          face check on that device refuses them. */}
      <PinAuthority canWrite={canWrite} />
      </div>
    </>
  );
}
