import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

/**
 * An organisation id that names nothing.
 *
 * The page already turns the service's refusal into a 404 (`asNotFound`), but
 * with no `not-found.tsx` anywhere under the console that 404 fell through to
 * the root one: no shell, "Go to the dashboard" and "Sign in" as the only
 * ways on, for a platform owner who is signed in and one click from the list.
 *
 * Sitting beside the page rather than at the console's root, because this is
 * the console's only detail route and the copy can then say what is actually
 * missing. A link mangled in a chat, a bookmark cut short, or a restore that
 * lost the row all arrive here; none of them is a fault.
 */
export default function OrganizationNotFound() {
  return (
    // The marker is for `verify-sweep`, which tells an intentional 404 apart
    // from a link pointing at nothing by this attribute, not the prose.
    <div data-notfound="platform">
      <EmptyState
        icon={FileQuestion}
        title="That organisation could not be found"
        description="The address may be mistyped or cut short, or the organisation may have been removed. The list has every organisation that exists here."
        action={
          <Button asChild variant="secondary">
            <Link href="/platform/organisations">All organisations</Link>
          </Button>
        }
      />
    </div>
  );
}
