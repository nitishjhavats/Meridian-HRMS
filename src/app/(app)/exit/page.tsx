import { requirePageContext } from "@/lib/auth/context";
import { employeeName } from "@/domain/employees/name";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { listExits } from "@/services/exit";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { ExitList, StartExit, type ExitItem } from "./ExitList";

export const metadata = { title: "Exits" };
export const dynamic = "force-dynamic";

export default async function ExitsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "exit.manage",
    module: "exit",
    what: "exits",
  });
  if (denied) return denied;

  const [exits, employees, activeCount] = await Promise.all([
    listExits(ctx),
    prisma.employee.findMany({
      // Somebody already leaving should not appear as a candidate again. A
      // cancelled exit is not "already leaving": they withdrew, and the
      // service reopens that row when they resign a second time. Filtering on
      // "has no exit record" hid them for good after the first withdrawal.
      where: {
        organizationId: ctx.organizationId!,
        active: true,
        OR: [{ exitRecord: null }, { exitRecord: { status: "CANCELLED" } }],
      },
      orderBy: { employeeCode: "asc" },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
    }),
    // So an empty picker can say which of the two reasons applies.
    prisma.employee.count({ where: { organizationId: ctx.organizationId!, active: true } }),
  ]);

  const open = exits.filter((e) => e.status !== "SETTLED" && e.status !== "CANCELLED");
  const owing = exits.filter((e) => e.settlement && e.settlement.status !== "PAID");

  return (
    <>
      <PageHeader
        title="Exits"
        description="Notice, clearance and final settlement for people leaving."
        action={
          <StartExit
            employees={employees.map((e) => ({
              id: e.id,
              name: employeeName(e, "—"),
              code: e.employeeCode,
            }))}
            activeCount={activeCount}
          />
        }
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="In progress" value={String(open.length)} />
          <Stat
            label="Serving notice"
            value={String(exits.filter((e) => e.status === "NOTICE_PERIOD").length)}
          />
          <Stat label="Settlements pending" value={String(owing.length)} />
          <Stat
            label="Completed"
            value={String(exits.filter((e) => e.status === "SETTLED").length)}
          />
        </StatGrid>
      </div>

      <Section title="Everyone leaving" description="Open exits first">
        <ExitList exits={exits as ExitItem[]} />
      </Section>
    </>
  );
}
