import { KeyRound } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { listResetRequests } from "@/services/auth/passwordReset";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDateTime, formatRelative, pluralise } from "@/lib/utils";
import { ResetActions } from "./ResetActions";

export const metadata = { title: "Password resets" };
export const dynamic = "force-dynamic";

const TONE = {
  PENDING: "warning",
  RELEASED: "info",
  CONSUMED: "success",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

export default async function PasswordResetsPage() {
  const ctx = await requirePageContext({ superadmin: true });
  const requests = await listResetRequests(ctx);
  const waiting = requests.filter((r) => r.status === "PENDING" && !r.expired);

  return (
    <>
      <PageHeader
        title="Password resets"
        description="Owner and Admin resets come to you. The code is never sent to the person who asked for it."
      />

      <div className="mb-4">
        <Alert tone="info" title="How this works">
          When an Owner or Admin asks to reset their password, the system generates a code but
          never shows it to them. You verify the request is genuine, release the code here, and
          pass it on yourself. It is single-use and expires.
        </Alert>
      </div>

      <Section
        title={waiting.length > 0 ? `${pluralise(waiting.length, "request")} waiting` : "All requests"}
        description="Newest first."
      >
        <ResponsiveList
          items={requests}
          empty={
            <EmptyState
              icon={KeyRound}
              title="No reset requests"
              description="They will appear here as soon as someone asks."
            />
          }
          head={
            <>
              <TH>Person</TH>
              <TH>Organisation</TH>
              <TH>Role</TH>
              <TH>Status</TH>
              <TH>Requested</TH>
              <TH>Expires</TH>
              <TH>Actions</TH>
            </>
          }
          row={(r) => (
            <TR key={r.id}>
              <TD>
                <span className="font-medium">{r.userName}</span>
                <span className="block text-xs text-muted-foreground">{r.userEmail}</span>
              </TD>
              <TD>{r.organizationName ?? "—"}</TD>
              <TD className="text-xs">{r.userRole.replaceAll("_", " ").toLowerCase()}</TD>
              <TD>
                <Badge tone={r.expired ? "neutral" : (TONE[r.status as keyof typeof TONE] ?? "neutral")}>
                  {r.expired && r.status !== "CONSUMED" ? "expired" : r.status.toLowerCase()}
                </Badge>
                {r.attemptCount > 0 ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {r.attemptCount} failed
                  </span>
                ) : null}
              </TD>
              <TD className="text-xs text-muted-foreground">
                {formatRelative(r.createdAt)}
                {r.ipAddress ? <span className="block font-mono">{r.ipAddress}</span> : null}
              </TD>
              <TD className="text-xs text-muted-foreground">{formatDateTime(r.expiresAt)}</TD>
              <TD>
                <ResetActions request={r} />
              </TD>
            </TR>
          )}
          card={(r) => (
            <div key={r.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.userName}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.userEmail}</p>
                </div>
                <Badge tone={r.expired ? "neutral" : (TONE[r.status as keyof typeof TONE] ?? "neutral")}>
                  {r.expired && r.status !== "CONSUMED" ? "expired" : r.status.toLowerCase()}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {r.organizationName ?? "—"} · {r.userRole.replaceAll("_", " ").toLowerCase()} ·{" "}
                {formatRelative(r.createdAt)}
              </p>
              <div className="mt-2.5">
                <ResetActions request={r} />
              </div>
            </div>
          )}
        />
      </Section>
    </>
  );
}
