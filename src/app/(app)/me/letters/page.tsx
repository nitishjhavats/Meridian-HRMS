import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listLetters } from "@/services/letters";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { LetterList, type LetterItem } from "../../letters/LetterList";

export const metadata = { title: "My letters" };
export const dynamic = "force-dynamic";

export default async function MyLettersPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    ownEmployeeRecord: true,
    permission: "letter.read.self",
    module: "letters",
    what: "your letters",
  });
  if (denied) return denied;

  if (!ctx.employeeId) {
    return (
      <>
        <PageHeader title="My letters" />
        <Alert tone="info" title="No employee record">
          Your login is not linked to an employee record yet. Ask HR to connect them.
        </Alert>
      </>
    );
  }

  // Only issued letters reach an employee — a draft about somebody is not yet
  // a statement anyone has made.
  //
  // Said explicitly, because `listLetters` only narrows on its own for someone
  // who holds nothing but `letter.read.self`. An HR manager or the owner holds
  // `letter.read.all`, and for them the unfiltered call is the organisation's
  // whole register -- every employee's letters, drafts and revocations
  // included -- under a heading that says "Issued to you".
  const letters = await listLetters(ctx, { employeeId: ctx.employeeId, status: "ISSUED" });

  return (
    <>
      <PageHeader
        title="My letters"
        description="Official letters your organisation has issued to you."
      />
      <Section title="Issued to you" description="Newest first">
        <LetterList letters={letters as LetterItem[]} canManage={false} showOwner={false} />
      </Section>
    </>
  );
}
