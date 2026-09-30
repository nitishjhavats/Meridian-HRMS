import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { MakerCredit } from "@/components/brand/MakerCredit";

export const metadata = { title: "Page not found" };

/**
 * A URL that matches nothing at all.
 *
 * Distinct from `(app)/not-found.tsx`, which renders inside the signed-in shell
 * for a record that is missing or out of scope. This one is reached by anybody,
 * signed in or not, so it cannot touch the auth context or the app shell — the
 * same constraint `offline/page.tsx` works under, and it is built the same way.
 *
 * Without it, a mistyped address or a stale bookmark got Next's own bare "This
 * page could not be found" — unbranded, and with no way back.
 */
export default function NotFound() {
  return (
    <main id="main" data-notfound="root" className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto w-fit rounded-full bg-muted p-4">
          <FileQuestion className="size-7 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold">That page isn&apos;t here</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The address may be mistyped, or the page may have moved. Nothing is wrong with your
          account.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Go to the dashboard
          </Link>
          <Link
            href="/login"
            className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
          >
            Sign in
          </Link>
        </div>
        <div className="mt-8 flex justify-center">
          <MakerCredit />
        </div>
      </div>
    </main>
  );
}
