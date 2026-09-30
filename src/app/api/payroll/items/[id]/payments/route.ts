import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, route } from "@/lib/http/handler";
import {
  deletePayment,
  listPayments,
  recordPayment,
  settleZeroNet,
} from "@/services/payroll/disbursement";

const paymentSchema = z.object({
  amountPaise: z.number().int().min(1),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(80).optional(),
  remarks: z.string().trim().max(300).optional(),
});

const settleSchema = z.object({ settleZeroNet: z.literal(true) });

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ payments: await listPayments(ctx, params.id) });
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const raw: unknown = await request.json().catch(() => null);

  /**
   * Two shapes on one route, because they are the same act.
   *
   * A payslip that comes to nothing cannot be paid -- zero is refused as an
   * amount, and anything above zero is more than the nothing outstanding -- so
   * closing it is a settlement rather than a payment, and writes no
   * `SalaryPayment` row.
   */
  const settle = settleSchema.safeParse(raw);
  if (settle.success) {
    return created({ settled: await settleZeroNet(ctx, params.id) });
  }

  const body = paymentSchema.parse(raw);
  return created({ payment: await recordPayment(ctx, { ...body, payrollItemId: params.id }) });
});

const deleteSchema = z.object({
  paymentId: z.string().min(1),
  reason: z.string().trim().min(1).max(300),
});

export const DELETE = route<{ id: string }>(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, deleteSchema);
  await deletePayment(ctx, body.paymentId, body.reason);
  return json({ ok: true });
});
