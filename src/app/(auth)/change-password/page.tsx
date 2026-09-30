import { redirect } from "next/navigation";
import { optionalContext } from "@/lib/auth/context";
import { landingFor } from "@/lib/auth/landing";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata = { title: "Change your password" };
export const dynamic = "force-dynamic";

/**
 * Set your own password.
 *
 * Deliberately outside the app shell. Somebody arriving here on a one-time
 * password has not finished signing in — putting a sidebar full of links around
 * the form invites them to wander off and leave the account on a password that
 * was handed to them on a piece of paper. It also means the enforcement
 * redirect in the app layout cannot loop: this page is not inside it.
 */
export default async function ChangePasswordPage() {
  const ctx = await optionalContext();
  if (!ctx) redirect("/login");
  // A kiosk device is a shared screen with no person behind it; its password is
  // rotated by an administrator, not typed in here.
  if (ctx.role === "KIOSK") redirect("/kiosk");

  return (
    <ChangePasswordForm
      forced={ctx.mustChangePassword}
      email={ctx.email}
      returnTo={landingFor(ctx.role)}
      signOutTo={ctx.organization?.slug ? `/o/${ctx.organization.slug}` : "/login"}
    />
  );
}
