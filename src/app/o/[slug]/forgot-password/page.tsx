import { brandingForSlug } from "@/lib/branding";
import { ForgotPasswordForm } from "../../../(auth)/forgot-password/ForgotPasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forgotten password" };

export default async function TenantForgotPasswordPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const branding = await brandingForSlug(slug);
  const name = branding.organization?.name;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Forgotten your password?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {name
            ? `Your ${name} administrator hands the code over directly — nothing is emailed.`
            : "The code is handed over directly — nothing is emailed."}
        </p>
      </div>
      <ForgotPasswordForm />
    </>
  );
}
