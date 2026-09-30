import { route } from "@/lib/http/handler";
import { renderMySamplePayslip } from "@/services/payroll/samplePayslip";

/**
 * The signed-in employee's own sample payslip.
 *
 * **This route takes no parameters, and that is the security property.** Not a
 * path segment, not a query string, not a body — the employee is
 * `ctx.employeeId` and nothing a caller sends can change it. An employee must
 * never be able to read a colleague's salary, and an id on this URL is exactly
 * how that happens: one endpoint, one loop over employee ids, everybody's pay.
 * A check inside the service would be a second line of defence for a door that
 * does not need to exist. `services/payroll/samplePayslip.test.ts` fails if an
 * id is ever added here.
 *
 * Sibling of `preview/`, which renders the administrator's sample from
 * hard-coded round figures and is gated on `payroll.read.all`. This one needs
 * only `payroll.read.self`, because everything on it is the reader's own.
 *
 * `inline`, so it opens in the browser's own viewer: the point is to look at it,
 * and a download that has to be found in a folder is not looking.
 */
export const dynamic = "force-dynamic";

export const GET = route(async (_request, { ctx }) => {
  const { pdf } = await renderMySamplePayslip(ctx);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="my-sample-payslip.pdf"',
      // Never cached: a raise, a policy change or a corrected bank account has
      // to show on the next look, and this is somebody's salary sitting in a
      // shared cache otherwise.
      "Cache-Control": "no-store",
    },
  });
});
