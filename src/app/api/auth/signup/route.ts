import { z } from "zod";
import { createSession, describeDevice, setSessionCookie } from "@/lib/auth/session";
import { clientIdentifier, enforce } from "@/lib/ratelimit";
import { json, parseBody, publicRoute, requestMeta } from "@/lib/http/handler";
import { prisma } from "@/lib/db/prisma";
import { signUp } from "@/services/auth/signup";

/**
 * Create an organisation and become its Owner.
 *
 * Rate-limited by IP and by email: creating tenants is cheap for an attacker
 * and expensive for us, and three an hour from one host is already generous.
 * Both limits fail *closed* — a counter that is down must not become the hour
 * somebody provisions a thousand organisations.
 *
 * On success the new Owner is signed in immediately. Making somebody re-enter
 * the password they chose ten seconds ago is a step that only loses people.
 */
const signupSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Choose a password."),
  phone: z.string().trim().max(20).optional(),
  acceptedTerms: z.boolean(),
});

export const POST = publicRoute(async (request) => {
  const body = await parseBody(request, signupSchema);
  const meta = requestMeta(request);
  // Both, because they catch different things: one host behind CGNAT is many
  // people, and one email retried from many hosts is one determined attacker.
  await enforce("signup", `ip:${clientIdentifier(request.headers)}`);
  await enforce("signupEmail", `email:${body.email}`);

  const result = await signUp(body);

  const session = await createSession({
    userId: result.userId,
    organizationId: result.organizationId,
    role: "ORG_OWNER",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  await prisma.loginEvent
    .create({
      data: {
        userId: result.userId,
        organizationId: result.organizationId,
        email: result.email,
        success: true,
        reason: "SIGNUP",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        deviceLabel: describeDevice(meta.userAgent),
      },
    })
    .catch(() => undefined);

  await setSessionCookie(session.token, session.cookieExpiresAt);

  return json(
    {
      organizationName: result.organizationName,
      trialEndsAt: result.trialEndsAt,
      // Their organisation's own door. They are already signed in, so this is
      // not for them to sign in with -- it is the link they have to give every
      // person they are about to add, and until now nothing ever showed it to
      // them.
      slug: result.slug,
      signInUrl: result.signInUrl,
      email: result.email,
      redirectTo: "/dashboard",
    },
    { status: 201 },
  );
});
