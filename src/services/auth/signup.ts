import { prisma } from "@/lib/db/prisma";
import { signInUrl } from "@/services/employees/credentials";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { checkPassword, hashPassword } from "@/lib/auth/password";
import { LEGAL_VERSION } from "@/lib/legal";
import { writeAnonymousAudit } from "@/lib/audit";
import { provisionTenant } from "@/services/platform/organizations";

/**
 * Public sign-up.
 *
 * Anyone can create an organisation and become its Owner, on a trial. That is
 * the only thing this grants: a brand-new tenant with nothing in it. It cannot
 * reach an existing organisation, cannot pick its own seat count or trial
 * length, and cannot grant itself modules the platform has not made default —
 * all of those stay with the Superadmin.
 *
 * The Superadmin can switch the whole route off, in which case new tenants are
 * created only from the platform console.
 */

export interface SignUpInput {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  phone?: string;
  /** Ticked on the form. Refused without it, and the version is stored. */
  acceptedTerms?: boolean;
}

export interface SignUpResult {
  organizationId: string;
  userId: string;
  email: string;
  organizationName: string;
  trialEndsAt: Date | null;
  /**
   * The organisation's own front door, and the reason it is returned at all.
   *
   * The slug is derived silently from the name, which is right -- nobody
   * signing up should have to invent a URL. The consequence was that the one
   * person who has to forward that link to their staff was the one person never
   * shown it: this path signed them straight into `/dashboard` and the slug
   * appeared only in an audit row.
   */
  slug: string;
  signInUrl: string;
}

/**
 * A slug from the organisation name, made unique by suffix.
 *
 * The person signing up should not have to think about URL slugs, and asking
 * them to invent a unique one is a step where sign-ups are lost.
 */
async function deriveSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org";

  // Pad a very short name so it clears the 3-character minimum.
  const seed = base.length < 3 ? `${base}-hq` : base;

  if (!(await prisma.organization.findUnique({ where: { slug: seed } }))) return seed;

  for (let i = 2; i < 100; i++) {
    const candidate = `${seed}-${i}`;
    if (!(await prisma.organization.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  return `${seed}-${Date.now().toString(36)}`;
}

export async function signUp(input: SignUpInput): Promise<SignUpResult> {
  const settings = await prisma.platformSetting.findUnique({ where: { id: "singleton" } });
  if (!(settings?.selfSignupEnabled ?? false)) {
    throw new ForbiddenError(
      "New organisations are being created by invitation at the moment. Contact us to get started.",
    );
  }

  const email = input.email.trim().toLowerCase();
  const organizationName = input.organizationName.trim();

  if (organizationName.length < 2) {
    throw new ValidationError("Please enter your organisation's name.");
  }

  const strength = checkPassword(input.password);
  if (!strength.ok) throw new ValidationError(strength.problems.join(" "));

  /**
   * The acceptance has to be recorded, not assumed.
   *
   * There was no consent capture in this form at all. "They must have agreed to
   * the terms" is not something anybody can produce a year later, and the
   * version matters as much as the fact — the question is always what the terms
   * said *at the time*, not what they say now.
   */
  if (!input.acceptedTerms) {
    throw new ValidationError("Please accept the terms of service and the privacy policy.");
  }

  // Checked here for a clear message, and again inside the transaction where it
  // is actually enforced — between these two lines someone else could take it.
  if (await prisma.user.findFirst({ where: { email } })) {
    throw new ConflictError(
      "An account already uses that email address. Sign in instead, or reset your password.",
    );
  }

  const result = await provisionTenant({
    name: organizationName,
    slug: await deriveSlug(organizationName),
    seats: settings?.signupSeats ?? 5,
    billingMode: "TRIAL",
    trialDays: settings?.defaultTrialDays ?? 14,
    owner: { name: input.name.trim(), email, phone: input.phone?.trim() },
    actorId: null,
    passwordHash: await hashPassword(input.password),
    // They chose this password a moment ago; making them change it is noise.
    mustChangePassword: false,
  });

  await prisma.user.update({
    where: { id: result.owner.id },
    data: { termsAcceptedAt: new Date(), termsVersion: LEGAL_VERSION },
  });

  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: result.organization.id },
    select: { trialEndsAt: true },
  });

  await writeAnonymousAudit({
    action: "org.created",
    entityType: "Organization",
    entityId: result.organization.id,
    organizationId: result.organization.id,
    actorEmail: email,
    metadata: { via: "self-signup", slug: result.organization.slug },
  });

  return {
    organizationId: result.organization.id,
    userId: result.owner.id,
    email,
    organizationName: result.organization.name,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    slug: result.organization.slug,
    signInUrl: signInUrl(result.organization.slug),
  };
}
