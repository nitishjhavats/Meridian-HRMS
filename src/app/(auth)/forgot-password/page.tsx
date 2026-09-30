import { redirect } from "next/navigation";
import { optionalContext } from "@/lib/auth/context";
import { landingFor } from "@/lib/auth/landing";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const ctx = await optionalContext();
  if (ctx) redirect(landingFor(ctx.role));

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A code is released by an administrator and given to you directly — nothing is emailed.
        </p>
      </div>
      <ForgotPasswordForm />
    </>
  );
}
