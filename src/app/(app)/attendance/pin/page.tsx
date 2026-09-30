import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { hasPermission } from "@/lib/auth/guard";
import { listRecentPins, pinRoster } from "@/services/attendance/pinAuthority";
import { PageHeader } from "@/components/ui/stat";
import { PinDesk } from "./PinDesk";

export const metadata = { title: "Attendance PIN" };
export const dynamic = "force-dynamic";

/**
 * The PIN desk.
 *
 * Issuing a PIN used to live only on the employee profile page, behind
 * `employee.read.*` -- so a receptionist named on the PIN authority screen was
 * allowed to issue one by the service and had no screen to do it from. This is
 * that screen: pick the person, say why, read the code out, and see whether the
 * ones issued today were used.
 */
export default async function AttendancePinPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "attendance.pin.issue",
    module: "attendance",
    what: "attendance PINs",
  });
  if (denied) return denied;

  const [people, recent] = await Promise.all([pinRoster(ctx), listRecentPins(ctx)]);

  // A receptionist named on the PIN authority screen holds `attendance.pin.issue`
  // and nothing wider, so the team grid at /attendance refuses them. The way
  // back is to the attendance screen they *can* open: their own.
  const seesTeam =
    ctx.permissions.has("attendance.read.all") || ctx.permissions.has("attendance.read.team");
  const back = seesTeam
    ? { href: "/attendance", label: "Attendance" }
    : ctx.permissions.has("attendance.read.self")
      ? { href: "/me/attendance", label: "My attendance" }
      : { href: "/dashboard", label: "Dashboard" };

  return (
    <>
      <Link
        href={back.href}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {back.label}
      </Link>

      <PageHeader
        title="Attendance PIN"
        description="A one-time code for somebody the face check cannot verify today. It works once, for fifteen minutes, and the mark it makes is flagged for review."
      />

      <PinDesk
        people={people}
        initialRecent={recent.map((p) => ({
          ...p,
          issuedAt: p.issuedAt.toISOString(),
          expiresAt: p.expiresAt.toISOString(),
          usedAt: p.usedAt?.toISOString() ?? null,
        }))}
        seesEverybodys={hasPermission(ctx, "attendance.settings.manage")}
      />
    </>
  );
}
