import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listFlaggedEvents } from "@/services/attendance/review";
import { getAttendanceRules } from "@/services/policy";
import { PageHeader } from "@/components/ui/stat";
import { ReviewQueue } from "./ReviewQueue";

export const metadata = { title: "Attendance to review" };
export const dynamic = "force-dynamic";

/**
 * The flagged-attendance queue.
 *
 * `reviewFlaggedEvents` has been in the codebase since the kiosk was built with
 * no caller at all, and the notification an administrator receives when a face
 * check fails linked to a screen that did not exist. So every failed match since
 * then has been recorded, flagged, notified — and then left, which is the same
 * outcome as not checking.
 */
export default async function AttendanceReviewPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "attendance.override",
    module: "attendance",
    what: "attendance to review",
  });
  if (denied) return denied;

  const [events, rules] = await Promise.all([listFlaggedEvents(ctx), getAttendanceRules(ctx)]);

  return (
    <>
      <Link
        href="/attendance"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Attendance
      </Link>

      <PageHeader
        title="Attendance to review"
        description="Marks the face check could not confirm. The person is present in the record either way — this decides whether it stands."
      />

      <ReviewQueue initial={events} threshold={rules.faceMatch.threshold} />
    </>
  );
}
