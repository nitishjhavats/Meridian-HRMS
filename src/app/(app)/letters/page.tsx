import { requirePageContext } from "@/lib/auth/context";
import { employeeName } from "@/domain/employees/name";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { letterSuggestions, listLetters } from "@/services/letters";
import { isAiConfigured } from "@/lib/ai/openrouter";
import { PLACEHOLDERS } from "@/domain/letters/template";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { LetterComposer } from "./LetterComposer";
import { LetterList, type LetterItem } from "./LetterList";

export const metadata = { title: "Letters" };
export const dynamic = "force-dynamic";

export default async function LettersPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "letter.issue",
    module: "letters",
    what: "letters",
  });
  if (denied) return denied;

  const [letters, employees, aiConfigured, suggestions] = await Promise.all([
    listLetters(ctx),
    prisma.employee.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      orderBy: { employeeCode: "asc" },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
    }),
    ctx.modules.has("ai") ? isAiConfigured(ctx.organizationId!) : Promise.resolve(false),
    letterSuggestions(ctx),
  ]);

  const drafts = letters.filter((l) => l.status === "DRAFT");
  const issued = letters.filter((l) => l.status === "ISSUED");

  return (
    <>
      <PageHeader
        title="Letters"
        description="Offer, experience, confirmation and other official letters."
        action={
          <Button asChild variant="secondary" size="sm">
            <Link href="/letters/templates">
              <FileText className="size-4" aria-hidden />
              Templates
            </Link>
          </Button>
        }
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Issued" value={String(issued.length)} />
          <Stat label="Drafts" value={String(drafts.length)} />
          <Stat label="AI drafted" value={String(letters.filter((l) => l.aiGenerated).length)} />
          <Stat label="Revoked" value={String(letters.filter((l) => l.status === "REVOKED").length)} />
        </StatGrid>
      </div>

      <div className="mb-4">
        <LetterComposer
          employees={employees.map((e) => ({
            id: e.id,
            name: employeeName(e, "—"),
            code: e.employeeCode,
          }))}
          aiAvailable={aiConfigured}
          placeholders={PLACEHOLDERS.map((p) => ({ key: p.key, label: p.label }))}
          suggestions={suggestions}
        />
      </div>

      {drafts.length > 0 ? (
        <div className="mb-4">
          <Section title="Drafts" description="Not issued yet — still editable">
            <LetterList letters={drafts as LetterItem[]} canManage showOwner />
          </Section>
        </div>
      ) : null}

      <Section title="All letters" description="Newest first">
        <LetterList letters={letters as LetterItem[]} canManage showOwner />
      </Section>
    </>
  );
}
