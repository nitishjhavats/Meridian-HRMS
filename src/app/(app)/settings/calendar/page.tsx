import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getCalendar } from "@/services/org/calendar";
import { PageHeader } from "@/components/ui/stat";
import { CalendarSettings } from "./CalendarSettings";
import { SuggestedHolidays } from "./SuggestedHolidays";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

/**
 * Shifts, weekly offs and holidays.
 *
 * Guarded on write rather than read, unlike the attendance rules next door.
 * There is nothing to *understand* here without changing something — the
 * calendar as it applies to one person is already shown on their attendance
 * screen — so a read-only visitor would get a form they cannot use.
 */
export default async function CalendarSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "org.settings.write",
    module: "attendance",
    what: "the working calendar",
  });
  if (denied) return denied;

  const calendar = await getCalendar(ctx);

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
        title="Calendar"
        description="Shifts, weekly offs and holidays — what makes a day a working day, before anybody's attendance is looked at."
      />

      {/* Above the hand-built calendar, because it is what most organisations
          need and all of them used to have to type in by hand. */}
      <SuggestedHolidays canWrite={ctx.permissions.has("org.settings.write")} />

      <CalendarSettings initial={calendar} />
    </>
  );
}
