import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

/**
 * A record that is not there, or not yours.
 *
 * The wording has to cover both without saying which. A cross-tenant or
 * out-of-scope read returns 404 rather than 403 throughout this product,
 * precisely so that "you may not see this" and "this does not exist" are
 * indistinguishable from outside — naming the difference here would undo that
 * in the one place a person actually reads.
 *
 * So it says what is true of both cases and offers the way back, rather than
 * guessing at a cause or apologising for a fault that did not happen.
 */
export default function AppNotFound() {
  return (
    // The marker is for `verify-sweep`, which has to tell an intentional 404
    // apart from a link pointing at nothing. Matching the prose was fragile:
    // React escapes the apostrophe in one place and not the other.
    <div data-notfound="app">
      <EmptyState
        icon={FileQuestion}
        title="That page isn't here"
        description="It may have been removed, or it may not be one your role can open. If you followed a link from inside the app, tell an administrator where you clicked."
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">Back to the dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
