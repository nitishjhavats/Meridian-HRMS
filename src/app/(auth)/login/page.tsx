import { redirect } from "next/navigation";
import { optionalContext } from "@/lib/auth/context";
import { landingFor } from "@/lib/auth/landing";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const ctx = await optionalContext();
  if (ctx) redirect(landingFor(ctx.role));

  // Offered only when it actually works. The link used to be unconditional and
  // landed on "Sign-up is by invitation" whenever the switch was off.

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use the work email your organisation registered for you.
        </p>
      </div>
      <LoginForm />
    </>
  );
}

