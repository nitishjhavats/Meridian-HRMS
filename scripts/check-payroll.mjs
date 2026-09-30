import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const items = await p.payrollItem.findMany({
  include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
  orderBy: { employee: { employeeCode: "asc" } },
  take: 12,
});
const r = (n) => "₹" + (n / 100).toLocaleString("en-IN");
console.log("CODE   NAME              CTC        PAYABLE  GROSS      NET        PAID       STATUS");
for (const i of items) {
  console.log(
    i.employee.employeeCode.padEnd(7),
    `${i.employee.firstName} ${i.employee.lastName}`.padEnd(18),
    r(i.ctcMonthlyPaise).padEnd(11),
    `${i.payableDays}/${i.basisDays}`.padEnd(8),
    r(i.grossPaise).padEnd(11),
    r(i.netPaise).padEnd(11),
    r(i.paidPaise).padEnd(11),
    i.settlement,
  );
}
const one = items.find((i) => i.advanceRecoveredPaise > 0) ?? items[0];
console.log("\nTrace for", one.employee.firstName, "—", one.trace.length, "lines:");
for (const t of one.trace) console.log("  ", t.stage.padEnd(22), t.label.padEnd(28), r(t.amountPaise).padStart(12), " | ", t.formula);
await p.$disconnect();
