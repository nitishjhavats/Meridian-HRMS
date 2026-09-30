import { requirePageContext } from "@/lib/auth/context";
import { employeeName } from "@/domain/employees/name";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { listMyTasks, listTasks, listTemplates } from "@/services/onboarding";
import { PageHeader, Stat, StatGrid } from "@/components/ui/stat";
import { MyOnboarding } from "./MyOnboarding";
import { Onboarding, type Task, type Template } from "./Onboarding";

export const metadata = { title: "Onboarding" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const ctx = await requirePageContext({ org: true });

  /**
   * Two audiences, because the welcome notification sends the new joiner here.
   *
   * `onboarding.manage` is HR Manager and above — Managers and Team Leads are
   * deliberately excluded, since none of these services scope by team — so
   * gating the whole page on it meant the person being onboarded was told to
   * open a page that answered "you do not have access". They now get their own
   * checklist, read-only, from a query pinned to their own employee id.
   */
  if (!ctx.permissions.has("onboarding.manage")) {
    const denied = pageGuard(ctx, {
      module: "onboarding",
      ownEmployeeRecord: true,
      what: "your onboarding",
    });
    if (denied) return denied;

    return (
      <>
        <PageHeader
          title="Your onboarding"
          description="The steps HR is working through for your first weeks, and when each is due."
        />
        <MyOnboarding tasks={await listMyTasks(ctx)} />
      </>
    );
  }

  const denied = pageGuard(ctx, {
    permission: "onboarding.manage",
    module: "onboarding",
    what: "onboarding",
  });
  if (denied) return denied;

  const [tasks, templates, employees] = await Promise.all([
    listTasks(ctx),
    listTemplates(ctx),
    prisma.employee.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      orderBy: { joiningDate: "desc" },
      take: 100,
      select: { id: true, employeeCode: true, joiningDate: true, firstName: true, lastName: true, user: { select: { name: true } } },
    }),
  ]);

  const open = tasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS");
  const people = new Set(tasks.map((t) => t.employee.id));

  return (
    <>
      <PageHeader
        title="Onboarding"
        description="A template is a checklist for a new joiner. Applying it to somebody turns each step into a dated task, counted from the day they start."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Being onboarded" value={String(people.size)} />
          <Stat label="Open tasks" value={String(open.length)} />
          <Stat label="Overdue" value={String(tasks.filter((t) => t.overdue).length)} />
          <Stat label="Templates" value={String(templates.length)} />
        </StatGrid>
      </div>

      <Onboarding
        tasks={tasks as Task[]}
        templates={templates.map(
          (t): Template => ({
            id: t.id,
            name: t.name,
            description: t.description,
            issued: t._count.issued,
            tasks: t.tasks,
          }),
        )}
        employees={employees.map((e) => ({
          id: e.id,
          name: employeeName(e, "—"),
          code: e.employeeCode,
          joiningDate: e.joiningDate ? e.joiningDate.toISOString().slice(0, 10) : null,
        }))}
      />
    </>
  );
}
