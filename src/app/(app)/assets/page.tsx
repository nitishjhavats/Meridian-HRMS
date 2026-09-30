import { requirePageContext } from "@/lib/auth/context";
import { employeeName } from "@/domain/employees/name";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { listAssets } from "@/services/assets";
import { PageHeader, Stat, StatGrid } from "@/components/ui/stat";
import { AssetRegister, type Asset } from "./AssetRegister";

export const metadata = { title: "Assets" };
export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "asset.manage",
    module: "assets",
    what: "the asset register",
  });
  if (denied) return denied;

  const [assets, employees] = await Promise.all([
    listAssets(ctx),
    prisma.employee.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      orderBy: { employeeCode: "asc" },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
    }),
  ]);

  const out = assets.filter((a) => a.heldBy);

  return (
    <>
      <PageHeader
        title="Assets"
        description="Company property, who has it, and what is still out."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="In the register" value={String(assets.length)} />
          <Stat label="Issued" value={String(out.length)} />
          <Stat label="Available" value={String(assets.filter((a) => a.status === "AVAILABLE").length)} />
          <Stat label="Unacknowledged" value={String(out.filter((a) => !a.heldBy?.acknowledged).length)} />
        </StatGrid>
      </div>

      <AssetRegister
        assets={assets as Asset[]}
        employees={employees.map((e) => ({
          id: e.id,
          name: employeeName(e, "—"),
          code: e.employeeCode,
        }))}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        Anything still issued when somebody leaves appears on their exit, so a settlement can
        account for it.
      </p>
    </>
  );
}
