import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listCycles, listGoals, listReviews, reviewableHeadcount } from "@/services/performance";
import { listEmployees } from "@/services/employees";
import { PageHeader } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { Performance, type Cycle, type Goal, type Review } from "./Performance";

export const metadata = { title: "Performance" };
export const dynamic = "force-dynamic";

export default async function PerformancePage() {
  const ctx = await requirePageContext({ org: true });
  const canManage = ctx.permissions.has("performance.manage");
  // Setting somebody else a goal is the reviewing permission, not the cycle-
  // running one: the person who will have to judge the goal is the person who
  // should be able to set it.
  const canAssign = ctx.permissions.has("performance.review");

  const denied = pageGuard(ctx, {
    anyPermission: ["performance.manage", "performance.review", "performance.read.self"],
    module: "performance",
    what: "performance",
    /**
     * A login with no employee record has nothing of its own here -- no review
     * to write, no goals -- but running a cycle is not a personal act. The
     * owner of a new organisation is exactly this login: not in the directory
     * yet, holding `performance.manage`, and here to open the first cycle for
     * the staff they have just added. This page used to stop everybody without
     * a record at an alert, which left the product with no screen anywhere on
     * which a cycle could be created or opened.
     */
    ownEmployeeRecord: !canManage,
  });
  if (denied) return denied;

  const [reviews, goals, cycles, roster, reviewable] = await Promise.all([
    listReviews(ctx),
    listGoals(ctx),
    canManage ? listCycles(ctx) : Promise.resolve([]),
    // `listEmployees` is already scoped by `employee.read`, so a team lead is
    // offered their reporting line and HR the company. The service checks the
    // same thing again on the way in — this only decides what the list shows.
    canAssign ? listEmployees(ctx, { activeOnly: true }) : Promise.resolve([]),
    // The same query `openCycle` runs, so the "opens for N, skips M" shown
    // before the button is the number the button then produces.
    canManage ? reviewableHeadcount(ctx) : Promise.resolve(undefined),
  ]);

  // Where a login with no employee record can add itself. `/account/profile`
  // has a one-click "Add me to the directory", but the page is gated on
  // `org.settings.write`; an HR Manager granted `performance.manage` holds
  // `employee.create` without it, and following the link landed on a
  // refusal. They get the directory, where the add-employee form lives --
  // the same place `pageGuard`'s own no-record screen sends them.
  const selfAddHref = ctx.permissions.has("org.settings.write")
    ? "/account/profile"
    : ctx.permissions.has("employee.create")
      ? "/employees"
      : null;

  return (
    <>
      <PageHeader
        title="Performance"
        description="Your reviews and goals — and, if you manage people, theirs."
      />

      {!ctx.employeeId ? (
        <div className="mb-4">
          <Alert tone="info" title="Your login is not in the employee directory">
            So there is no review or goal of your own on this screen. The review cycles below
            still work.{" "}
            {selfAddHref ? (
              <>
                To be reviewed yourself,{" "}
                <Link href={selfAddHref} className="underline">
                  add yourself to the directory
                </Link>
                .
              </>
            ) : (
              "Ask an administrator to add you to the directory to be reviewed yourself."
            )}
          </Alert>
        </div>
      ) : null}

      <Performance
        reviews={reviews as Review[]}
        goals={goals as Goal[]}
        cycles={cycles as Cycle[]}
        people={roster.map((e) => ({
          id: e.id,
          name: e.name,
          employeeCode: e.employeeCode,
          detail: e.designation ?? e.department,
        }))}
        canManage={canManage}
        canAssign={canAssign}
        employeeId={ctx.employeeId}
        reviewable={reviewable}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        Nobody can browse everyone&apos;s reviews. You see your own and the ones you are the named
        reviewer on; a cycle owner sees progress, not contents.
      </p>
    </>
  );
}
