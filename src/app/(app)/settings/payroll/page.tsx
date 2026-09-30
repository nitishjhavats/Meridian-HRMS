import { redirect } from "next/navigation";

/**
 * Payroll rules, reached from Settings.
 *
 * The screen itself lives at `/payroll/rules`, beside the runs it governs, and
 * moving it would break every link and bookmark pointing there. But somebody
 * looking for "where do I change how pay is calculated" looks under Settings —
 * the hub already offers a card for it — and typing the address they expect
 * should not be a dead end.
 */
export const dynamic = "force-dynamic";

export default function SettingsPayrollPage() {
  redirect("/payroll/rules");
}
