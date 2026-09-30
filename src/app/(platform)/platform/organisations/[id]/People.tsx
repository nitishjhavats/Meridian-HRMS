import Link from "next/link";
import { Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/states";
import { formatRelative, pluralise } from "@/lib/utils";
import { ROLE_LABELS, type SystemRole } from "@/lib/auth/permissions";
import type { OrgPeoplePage, OrgPersonRow } from "@/services/platform/organizations";
import { SignInAs } from "./SignInAs";

/**
 * Everyone in a customer's organisation, and the way in to any of them.
 *
 * The previous version listed `organization.users`, so it showed the owner, the
 * office devices, and only those employees somebody had explicitly given a
 * login to. Impersonation never had a role allow-list -- most of a customer's
 * staff simply were not on the screen.
 *
 * Search and paging are query parameters on a plain GET form rather than client
 * state: this is a support screen reached from a link, and the thing somebody
 * wants to do with it is send that link to somebody else.
 *
 * A card list rather than a table, because the old one put "Sign in as" in the
 * fifth column of a horizontally scrolling table -- which
 * components/ui/table.tsx says in its own header comment is technically
 * responsive and practically unusable.
 */

function roleLabel(role: string | null): string {
  if (!role) return "No login";
  return ROLE_LABELS[role as SystemRole] ?? role;
}

function PersonCard({ person }: { person: OrgPersonRow }) {
  const subtitle = [person.employeeCode, person.designation, person.email]
    .filter(Boolean)
    .join(" · ");

  const meta = person.userId
    ? person.lastLoginAt
      ? `Last seen ${formatRelative(person.lastLoginAt)}`
      : "Never signed in"
    : "No account to act as";

  return (
    <li className="flex flex-wrap items-start gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="break-words">{person.name}</span>
          <Badge tone={person.userId ? "info" : "neutral"}>{roleLabel(person.role)}</Badge>
          {person.userId && person.status !== "ACTIVE" ? (
            <Badge tone="warning">{person.status?.toLowerCase()}</Badge>
          ) : null}
          {person.employmentState && !person.active ? (
            <Badge tone="neutral">
              {person.employmentState.replaceAll("_", " ").toLowerCase()}
            </Badge>
          ) : null}
        </p>
        {subtitle ? (
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
      {person.userId && person.status === "ACTIVE" ? (
        <div className="shrink-0">
          <SignInAs
            userId={person.userId}
            name={person.name}
            email={person.email ?? ""}
            role={person.role ?? ""}
          />
        </div>
      ) : null}
    </li>
  );
}

export function People({ organizationId, page }: { organizationId: string; page: OrgPeoplePage }) {
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const base = `/platform/organisations/${organizationId}`;
  const linkTo = (next: number) =>
    `${base}?${new URLSearchParams({
      ...(page.search ? { q: page.search } : {}),
      ...(next > 1 ? { page: String(next) } : {}),
    }).toString()}#people`;

  return (
    <div id="people" className="scroll-mt-4">
      <Section
        title="People"
        description="Everyone in the directory, with or without a login. Signing in as somebody is written to this organisation's own audit log."
      >
        <div className="space-y-4 p-4">
          <form method="get" action={base} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <label
                htmlFor="people-search"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Search by name, code or email
              </label>
              <Input
                id="people-search"
                name="q"
                type="search"
                defaultValue={page.search}
                placeholder="Sneha, ACM014, sneha@…"
              />
            </div>
            <Button type="submit" variant="secondary">
              <Search className="size-4" aria-hidden />
              Search
            </Button>
          </form>

          {page.accounts.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Accounts with no employee record
              </p>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {page.accounts.map((person) => (
                  <PersonCard key={person.userId} person={person} />
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {page.search
                ? `${pluralise(page.total, "match")} for “${page.search}”`
                : pluralise(page.total, "person")}
            </p>

            {page.employees.length === 0 ? (
              <EmptyState
                icon={Users}
                title={page.search ? "Nobody matches that" : "Nobody in the directory yet"}
                description={
                  page.search
                    ? "Try a partial name, or the employee code."
                    : "Employees appear here as soon as their organisation adds them."
                }
              />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {page.employees.map((person) => (
                  <PersonCard key={person.employeeId} person={person} />
                ))}
              </ul>
            )}
          </div>

          {pages > 1 ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              {page.page > 1 ? (
                <Link href={linkTo(page.page - 1)} className="text-primary hover:underline">
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-xs text-muted-foreground">
                Page {page.page} of {pages}
              </span>
              {page.page < pages ? (
                <Link href={linkTo(page.page + 1)} className="text-primary hover:underline">
                  Next →
                </Link>
              ) : (
                <span />
              )}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Somebody with no login cannot be signed in as &mdash; there is no account to act as.
            Their own administrator creates one from the employee&rsquo;s profile, which you can
            reach by signing in as that administrator.
          </p>
        </div>
      </Section>
    </div>
  );
}
