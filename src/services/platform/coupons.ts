import type { Coupon } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { randomToken } from "@/lib/crypto/field";

/** Discount coupons the platform owner issues against seat purchases. */

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  percent: number;
  maxDiscountPaise: number | null;
  startsAt: Date;
  expiresAt: Date;
  maxRedemptions: number | null;
  redemptionCount: number;
  maxPerOrganisation: number | null;
  minUserCount: number | null;
  maxUserCount: number | null;
  firstPurchaseOnly: boolean;
  listed: boolean;
  appliesToOrgId: string | null;
  appliesToOrgName: string | null;
  active: boolean;
  /** Derived: what the owner actually cares about at a glance. */
  state: "SCHEDULED" | "LIVE" | "EXHAUSTED" | "EXPIRED" | "INACTIVE";
  discountGivenPaise: number;
  createdAt: Date;
}

function stateOf(coupon: Coupon, now: Date): CouponRow["state"] {
  if (!coupon.active) return "INACTIVE";
  if (now < coupon.startsAt) return "SCHEDULED";
  if (now > coupon.expiresAt) return "EXPIRED";
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
    return "EXHAUSTED";
  }
  return "LIVE";
}

export async function listCoupons(ctx: AuthContext): Promise<CouponRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.coupon.manage");

  const [coupons, redemptions] = await Promise.all([
    prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: { organization: { select: { name: true } } },
    }),
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      _sum: { discountPaise: true },
    }),
  ]);

  const givenByCoupon = new Map(
    redemptions.map((r) => [r.couponId, r._sum.discountPaise ?? 0]),
  );
  const now = new Date();

  return coupons.map((c) => ({
    id: c.id,
    code: c.code,
    description: c.description,
    percent: Number(c.percent),
    maxDiscountPaise: c.maxDiscountPaise,
    startsAt: c.startsAt,
    expiresAt: c.expiresAt,
    maxRedemptions: c.maxRedemptions,
    redemptionCount: c.redemptionCount,
    maxPerOrganisation: c.maxPerOrganisation,
    minUserCount: c.minUserCount,
    maxUserCount: c.maxUserCount,
    firstPurchaseOnly: c.firstPurchaseOnly,
    listed: c.listed,
    appliesToOrgId: c.appliesToOrgId,
    appliesToOrgName: c.organization?.name ?? null,
    active: c.active,
    state: stateOf(c, now),
    discountGivenPaise: givenByCoupon.get(c.id) ?? 0,
    createdAt: c.createdAt,
  }));
}

export interface CouponInput {
  /** Leave blank to have one generated. */
  code?: string;
  description?: string;
  percent: number;
  maxDiscountPaise?: number | null;
  startsAt: Date;
  expiresAt: Date;
  maxRedemptions?: number | null;
  maxPerOrganisation?: number | null;
  minUserCount?: number | null;
  maxUserCount?: number | null;
  firstPurchaseOnly?: boolean;
  listed?: boolean;
  appliesToOrgId?: string | null;
  active?: boolean;
}

function validate(input: CouponInput): void {
  if (!(input.percent > 0 && input.percent <= 100)) {
    throw new ValidationError("The discount must be between 0 and 100 percent.");
  }
  if (input.expiresAt <= input.startsAt) {
    throw new ValidationError("The expiry must be after the start time.");
  }
  if (input.maxRedemptions != null && input.maxRedemptions < 1) {
    throw new ValidationError("The usage limit must be at least 1, or left blank for unlimited.");
  }
  if (input.maxPerOrganisation != null && input.maxPerOrganisation < 1) {
    throw new ValidationError(
      "The per-organisation limit must be at least 1, or left blank for unlimited.",
    );
  }
  if (
    input.maxRedemptions != null &&
    input.maxPerOrganisation != null &&
    input.maxPerOrganisation > input.maxRedemptions
  ) {
    throw new ValidationError(
      "One organisation cannot be allowed more uses than the coupon has in total.",
    );
  }
  if (input.firstPurchaseOnly && input.maxPerOrganisation != null && input.maxPerOrganisation > 1) {
    // A first purchase happens once. Anything above one is a setting that can
    // never be reached, which reads on the screen as a limit that does not work.
    throw new ValidationError(
      "A first-purchase coupon can only be used once by an organisation.",
    );
  }
  if (
    input.minUserCount != null &&
    input.maxUserCount != null &&
    input.minUserCount > input.maxUserCount
  ) {
    throw new ValidationError("The minimum user count cannot exceed the maximum.");
  }
}

/** Ambiguous characters are left out so a code read aloud cannot be mistyped. */
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomToken(12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[raw.charCodeAt(i % raw.length) % alphabet.length];
  }
  return out;
}

export async function createCoupon(ctx: AuthContext, input: CouponInput): Promise<Coupon> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.coupon.manage");
  validate(input);

  const code = (input.code?.trim() || generateCode()).toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(code)) {
    throw new ValidationError("A code must be 4–32 characters of letters, numbers, hyphen or underscore.");
  }
  if (await prisma.coupon.findUnique({ where: { code } })) {
    throw new ConflictError(`The code ${code} is already in use.`);
  }

  const coupon = await prisma.coupon.create({
    data: {
      code,
      description: input.description?.trim() || null,
      percent: input.percent,
      maxDiscountPaise: input.maxDiscountPaise ?? null,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      maxRedemptions: input.maxRedemptions ?? null,
      // Blank is a real answer on every limit: no ceiling, unlimited uses, any
      // order size. Stored as null rather than as a zero, which would read as
      // "nobody may use this".
      maxPerOrganisation: input.maxPerOrganisation ?? null,
      minUserCount: input.minUserCount ?? null,
      maxUserCount: input.maxUserCount ?? null,
      firstPurchaseOnly: input.firstPurchaseOnly ?? false,
      listed: input.listed ?? false,
      appliesToOrgId: input.appliesToOrgId ?? null,
      active: input.active ?? true,
      createdById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "coupon.created",
    entityType: "Coupon",
    entityId: coupon.id,
    after: {
      code: coupon.code,
      percent: Number(coupon.percent),
      expiresAt: coupon.expiresAt,
      listed: coupon.listed,
      active: coupon.active,
      maxPerOrganisation: coupon.maxPerOrganisation,
      firstPurchaseOnly: coupon.firstPurchaseOnly,
      appliesToOrgId: coupon.appliesToOrgId,
    },
  });

  return coupon;
}

export async function updateCoupon(
  ctx: AuthContext,
  couponId: string,
  input: Partial<CouponInput>,
): Promise<Coupon> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.coupon.manage");

  const before = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!before) throw new NotFoundError("That coupon");

  const merged: CouponInput = {
    percent: input.percent ?? Number(before.percent),
    startsAt: input.startsAt ?? before.startsAt,
    expiresAt: input.expiresAt ?? before.expiresAt,
    maxRedemptions: input.maxRedemptions ?? before.maxRedemptions,
    maxPerOrganisation: input.maxPerOrganisation ?? before.maxPerOrganisation,
    minUserCount: input.minUserCount ?? before.minUserCount,
    maxUserCount: input.maxUserCount ?? before.maxUserCount,
    firstPurchaseOnly: input.firstPurchaseOnly ?? before.firstPurchaseOnly,
  };
  validate(merged);

  // The code is deliberately immutable: it may already be printed in an email
  // or sitting in a half-finished order.
  const coupon = await prisma.coupon.update({
    where: { id: couponId },
    data: {
      description: input.description?.trim() ?? before.description,
      percent: merged.percent,
      maxDiscountPaise: input.maxDiscountPaise ?? before.maxDiscountPaise,
      startsAt: merged.startsAt,
      expiresAt: merged.expiresAt,
      maxRedemptions: merged.maxRedemptions,
      maxPerOrganisation: merged.maxPerOrganisation,
      minUserCount: merged.minUserCount,
      maxUserCount: merged.maxUserCount,
      firstPurchaseOnly: merged.firstPurchaseOnly ?? false,
      listed: input.listed ?? before.listed,
      appliesToOrgId: input.appliesToOrgId !== undefined ? input.appliesToOrgId : before.appliesToOrgId,
      active: input.active ?? before.active,
    },
  });

  await writeAudit(ctx, {
    action: "coupon.updated",
    entityType: "Coupon",
    entityId: couponId,
    before: {
      percent: Number(before.percent),
      active: before.active,
      listed: before.listed,
      expiresAt: before.expiresAt,
    },
    after: {
      percent: Number(coupon.percent),
      active: coupon.active,
      listed: coupon.listed,
      expiresAt: coupon.expiresAt,
    },
  });

  return coupon;
}

/**
 * Coupons are deactivated, never deleted, once they have been redeemed —
 * deleting one would orphan the discount recorded against a real payment.
 */
export async function deactivateCoupon(ctx: AuthContext, couponId: string): Promise<void> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.coupon.manage");

  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) throw new NotFoundError("That coupon");

  if (coupon.redemptionCount === 0) {
    await prisma.coupon.delete({ where: { id: couponId } });
  } else {
    await prisma.coupon.update({ where: { id: couponId }, data: { active: false } });
  }

  await writeAudit(ctx, {
    action: "coupon.updated",
    entityType: "Coupon",
    entityId: couponId,
    before: { active: coupon.active },
    after: { active: false, deleted: coupon.redemptionCount === 0 },
  });
}

/**
 * Who used a coupon, by name.
 *
 * `CouponRedemption` carries the organisation's id and no relation to it, so
 * the rows alone answered "which organisations used this?" with a list of
 * cuids -- which is the only question the count on the list leads to. The
 * names are looked up in one query over the distinct ids and attached here,
 * rather than in the dialog, so the read stays one round trip.
 */
export async function getCouponRedemptions(ctx: AuthContext, couponId: string) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.coupon.manage");

  const redemptions = await prisma.couponRedemption.findMany({
    where: { couponId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const organizationIds = [...new Set(redemptions.map((r) => r.organizationId))];
  const organizations =
    organizationIds.length === 0
      ? []
      : await prisma.organization.findMany({
          where: { id: { in: organizationIds } },
          select: { id: true, name: true },
        });
  const nameOf = new Map(organizations.map((o) => [o.id, o.name]));

  // `null` when the organisation is gone: the row outlives it, because there
  // is no relation to cascade on, and a discount that was given was given.
  return redemptions.map((r) => ({
    ...r,
    organizationName: nameOf.get(r.organizationId) ?? null,
  }));
}
