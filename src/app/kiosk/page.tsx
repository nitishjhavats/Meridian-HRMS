import { requirePageContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { getKioskContext, getKioskRoster } from "@/services/attendance/kiosk";
import { DeviceStopped } from "./DeviceStopped";
import { shellBranding } from "@/lib/branding";
import { KioskScreen } from "./KioskScreen";

export const metadata = { title: "Attendance" };
export const dynamic = "force-dynamic";

export default async function KioskPage() {
  const ctx = await requirePageContext();
  /**
   * A device whose branch was switched off, or whose row was revoked, is a
   * sentence on the screen and a way to sign out -- not the fault screen. The
   * roster refresh reloads this page when the API starts refusing, so this is
   * exactly what a reception tablet shows the next person who walks up.
   */
  let device: Awaited<ReturnType<typeof getKioskContext>>;
  try {
    device = await getKioskContext(ctx);
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) {
      return <DeviceStopped message={error.message} />;
    }
    throw error;
  }
  const [roster, branding] = await Promise.all([
    getKioskRoster(ctx),
    shellBranding(ctx.organizationId),
  ]);

  return (
    <KioskScreen
      device={device}
      initialRoster={roster}
      organizationLogoUrl={branding.organization?.logoUrl ?? null}
      platformLogoUrl={branding.platformLogoUrl}
      maker={branding.maker}
      // The kiosk renders no app shell, so the banner that normally says "you
      // are acting as somebody" has nowhere to appear. Without this a support
      // engineer on a reception screen has no sign they are impersonating and
      // no way out except the device's own sign-out, which is the button that
      // used to strand them.
      impersonating={ctx.impersonating?.byEmail ?? null}
    />
  );
}
