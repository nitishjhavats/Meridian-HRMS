import Link from "next/link";
import { Download, KeyRound, ShieldCheck } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { LEGAL_PAGES } from "@/lib/legal";
import { getTwoFactorStatus } from "@/services/auth/twoFactor";
import { listLoginHistory, listSessions } from "@/services/auth/sessions";
import { SecuritySettings } from "./SecuritySettings";

export const metadata = { title: "Security" };
export const dynamic = "force-dynamic";

/**
 * Your own account's security.
 *
 * There is no permission on this page on purpose: everything it shows belongs
 * to the person looking at it, and every service behind it filters on
 * `ctx.userId`. A Team Member has exactly as much right to see their own
 * sessions as an Owner does.
 */
export default async function SecurityPage() {
  const ctx = await requirePageContext({ org: true });
  // Where somebody with no employee record can add themselves. The profile
  // screen has the button but is gated on org.settings.write; an HR manager
  // holds employee.create without it, so they go to the directory instead --
  // the same rule the performance page and pageGuard apply.
  const selfAddHref = ctx.permissions.has("org.settings.write")
    ? "/account/profile"
    : ctx.permissions.has("employee.create")
      ? "/employees"
      : null;

  const [status, sessions, history] = await Promise.all([
    getTwoFactorStatus(ctx),
    listSessions(ctx),
    listLoginHistory(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Security"
        description={`Signed in as ${ctx.email}. These settings cover this account only.`}
      />

      <Section
        title="Password"
        description="Change it whenever you like. You will need the current one."
      >
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">
            Changing it signs out every other device you are signed in on.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link href="/change-password">
              <KeyRound className="size-4" aria-hidden />
              Change password
            </Link>
          </Button>
        </div>
      </Section>

      <div className="mt-4">
        <Section
          title="Your data"
          description="What this product holds about you, and where to read the policies."
        >
          {ctx.employeeId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="max-w-lg text-sm text-muted-foreground">
                Download your own record — your details, attendance, leave, payslips, documents,
                letters and sign-in history — as a file you can keep. Identification numbers are
                shown as the last four digits only.
              </p>
              <Button asChild variant="secondary" size="sm">
                {/* A plain link, not a fetch: the response is the file. */}
                <a href="/api/me/export" download>
                  <Download className="size-4" aria-hidden />
                  Download my data
                </a>
              </Button>
            </div>
          ) : (
            <div className="p-4">
              {/*
               * The export is the employee record, and this login has none — an
               * owner or administrator of an organisation created before owners
               * were added to the directory automatically, or an HR login made
               * without one. Offering the link anyway is worse than nothing:
               * because it carries `download`, the browser treats the service's
               * refusal as a failed download and the page itself says nothing.
               * So say it here, the way every other screen does.
               */}
              <Alert tone="info" title="Your login is not linked to an employee record">
                There is nothing to download yet: the record this exports belongs to an
                employee, and this login is not one.{" "}
                {selfAddHref ? (
                  <>
                    <Link href={selfAddHref} className="underline">
                      Add yourself to the directory
                    </Link>{" "}
                    and your data will be here to download.
                  </>
                ) : (
                  "Ask an administrator to add you to the employee directory."
                )}
              </Alert>
            </div>
          )}
          <div className="border-t border-border px-4 py-3">
            <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {LEGAL_PAGES.map((page) => (
                <a
                  key={page.href}
                  href={page.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {page.title}
                </a>
              ))}
            </nav>
          </div>
        </Section>
      </div>

      <div className="mt-4">
        <SecuritySettings status={status} sessions={sessions} history={history} />
      </div>

      <p className="mt-4 flex gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span>
          Your two-factor secret is encrypted before it is stored, and recovery codes are kept only
          as hashes — nobody, including an administrator, can read them back.
        </span>
      </p>
    </>
  );
}
