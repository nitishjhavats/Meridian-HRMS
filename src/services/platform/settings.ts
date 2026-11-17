import type { PlatformSetting } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { InvalidCodePrefix, normaliseCodePrefix } from "@/domain/employees/code";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Platform settings.
 *
 * Price per user, the UPI id and the confirmation window all live here rather
 * than in code, which is what lets the owner change pricing without a deploy.
 * There is exactly one row.
 */

export async function getSettings(): Promise<PlatformSetting> {
  const existing = await prisma.platformSetting.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  return prisma.platformSetting.create({ data: { id: "singleton" } });
}

export interface SettingsPatch {
  pricePerUserPaise?: number;
  paymentUpiId?: string;
  /** Three or four letters. Leads every invoice number the platform issues. */
  invoicePrefix?: string;
  paymentPayeeName?: string;
  paymentWindowMinutes?: number;
  confirmationMode?: "UTR" | "CODE" | "BOTH";
  otpTtlMinutes?: number;
  defaultTrialDays?: number;
  seatGraceDays?: number;
  selfieRetentionDays?: number;
  defaultAiModel?: string;
  maintenanceMode?: boolean;
  selfSignupEnabled?: boolean;
}

const UPI_PATTERN = /^[\w.\-]{2,64}@[a-zA-Z]{2,32}$/;

/**
 * What invoices are numbered with until the owner chooses otherwise: the
 * column's own default, and what `orders.ts` falls back to for a missing one.
 */
const DEFAULT_INVOICE_PREFIX = "BMG";

export async function updateSettings(
  ctx: AuthContext,
  patch: SettingsPatch,
): Promise<PlatformSetting> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.settings.manage");

  if (patch.pricePerUserPaise != null) {
    if (!Number.isInteger(patch.pricePerUserPaise) || patch.pricePerUserPaise < 0) {
      throw new ValidationError("The price per user must be a whole number of paise.");
    }
    if (patch.pricePerUserPaise > 10_000_00) {
      throw new ValidationError("That price looks wrong — it is over ₹10,000 per user.");
    }
  }
  // An empty payee is "not set yet", not a malformed one: a fresh install has
  // no default payee, and refusing it here refused every other setting on the
  // same form. Empty is never written (see below); with no payee saved, orders
  // use PAYMENT_UPI_ID, and are refused when that is unset too.
  if (patch.paymentUpiId?.trim() && !UPI_PATTERN.test(patch.paymentUpiId.trim())) {
    throw new ValidationError("That does not look like a UPI ID (for example name@bank).");
  }
  if (patch.paymentWindowMinutes != null && (patch.paymentWindowMinutes < 15 || patch.paymentWindowMinutes > 10_080)) {
    throw new ValidationError("The confirmation window must be between 15 minutes and 7 days.");
  }
  if (patch.otpTtlMinutes != null && (patch.otpTtlMinutes < 5 || patch.otpTtlMinutes > 120)) {
    throw new ValidationError("The OTP lifetime must be between 5 and 120 minutes.");
  }
  if (patch.selfieRetentionDays != null && (patch.selfieRetentionDays < 1 || patch.selfieRetentionDays > 3_650)) {
    throw new ValidationError("Selfie retention must be between 1 day and 10 years.");
  }

  /**
   * The invoice prefix, checked here and kept out of the spread below.
   *
   * It used to be spread in with the rest and then overridden "when set" --
   * so an empty box, which the settings form always sends, went through the
   * spread as `""` and was saved, and every order from then on was numbered
   * `-2026-0001`: `orders.ts` falls back to the default for a missing prefix,
   * not for an empty one. And a one-letter prefix threw the domain's plain
   * Error out of the middle of the update, which the route answered as a 500.
   *
   * An empty box means the default, not a refusal: the form's hint beside it
   * already says so -- "Invoices are numbered BMG-..." -- and clearing the box
   * is the only way the owner has to go back to it.
   */
  const { invoicePrefix: rawPrefix, ...rest } = patch;
  let invoicePrefix: string | undefined;
  if (rawPrefix !== undefined) {
    if (rawPrefix.trim() === "") {
      invoicePrefix = DEFAULT_INVOICE_PREFIX;
    } else {
      try {
        invoicePrefix = normaliseCodePrefix(rawPrefix);
      } catch (error) {
        if (error instanceof InvalidCodePrefix) {
          throw new ValidationError("The invoice prefix is three or four letters, A to Z.");
        }
        throw error;
      }
    }
  }

  const before = await getSettings();

  const updated = await prisma.platformSetting.update({
    where: { id: "singleton" },
    data: {
      ...rest,
      // Undefined leaves the stored payee alone; an empty box never clears it.
      paymentUpiId: rest.paymentUpiId?.trim() || undefined,
      ...(invoicePrefix !== undefined ? { invoicePrefix } : {}),
      updatedById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "PlatformSetting",
    entityId: "singleton",
    before: {
      pricePerUserPaise: before.pricePerUserPaise,
      paymentUpiId: before.paymentUpiId,
      invoicePrefix: before.invoicePrefix,
      paymentWindowMinutes: before.paymentWindowMinutes,
      confirmationMode: before.confirmationMode,
      selfSignupEnabled: before.selfSignupEnabled,
    },
    after: {
      pricePerUserPaise: updated.pricePerUserPaise,
      paymentUpiId: updated.paymentUpiId,
      invoicePrefix: updated.invoicePrefix,
      paymentWindowMinutes: updated.paymentWindowMinutes,
      confirmationMode: updated.confirmationMode,
      selfSignupEnabled: updated.selfSignupEnabled,
    },
  });

  return updated;
}
