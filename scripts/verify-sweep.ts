/**
 * Five-role page sweep.
 *
 *   npm run verify:sweep                       # against the dev server
 *   BASE=https://your-domain npm run verify:sweep
 *
 * Signs in as each seeded role and fetches every page, failing on a 5xx or on
 * Next's client error screen. A rendered "you do not have access" screen is a
 * pass — that is the guard working, not a crash.
 *
 * This is the cheapest test in the project and it has caught real breakage more
 * than once: a nav link with no page behind it, a page that threw for one role
 * only, a service that assumed an employee record.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";
import { hashPassword } from "../src/lib/auth/password";

/**
 * Against a remote deployment the database is not reachable from here — it
 * lives on a private docker network — so the accounts can be supplied directly:
 *
 *   SWEEP_LOGINS="ORG_OWNER=a@b.com,ADMIN=c@d.com" BASE=https://… npm run verify:sweep
 *
 * Without it the seeded accounts are looked up in the database as before.
 */
const SUPPLIED = process.env.SWEEP_LOGINS
  ? new Map(
      process.env.SWEEP_LOGINS.split(",").map((pair) => {
        const [role, email] = pair.split("=");
        return [role!.trim(), email!.trim()] as const;
      }),
    )
  : null;

const BASE = process.env.BASE ?? "http://localhost:3000";
const PASSWORD = process.env.SWEEP_PASSWORD ?? "Password@123";
const SLUG = process.env.SWEEP_ORG ?? "acme";

const PAGES = [
  "/dashboard",
  "/employees",
  "/attendance",
  "/me/attendance",
  "/leave",
  "/me/leave",
  "/payroll",
  "/payroll/rules",
  "/me/salary",
  "/documents",
  "/me/documents",
  "/letters",
  "/me/letters",
  "/announcements",
  "/notifications",
  "/reports",
  "/reimbursements",
  "/onboarding",
  "/assets",
  "/performance",
  "/exit",
  "/audit",
  "/billing",
  "/settings",
  "/settings/modules",
  "/settings/organisation",
  "/settings/ai",
  "/settings/export",
  "/settings/attendance",
  "/payroll/advances",
  "/account/security",
  // A redirect target with no page reached production once. Anything the app
  // sends somebody to belongs in this list, not only what the nav links to.
  "/change-password",
  // Shipped after this list was last touched. It covered 30 of 66 page routes
  // and none of the newest, which is the opposite of what a 404 guard is for.
  "/attendance/review",
  "/letters/templates",
  "/recognition",
  "/recognition/settings",
  "/settings/calendar",
  "/settings/leave-balances",
  "/settings/permissions",
  "/settings/salary",
  "/chat",
  "/chat/reports",
  // Round 12 and 13.
  "/account/profile",
  "/attendance/pin",
  "/settings/leave-types",
  "/settings/payroll",
];

/**
 * The platform console, swept as the superadmin.
 *
 * Never swept before this list existed. The pages are read with the seeded
 * superadmin from `.env`; against a remote deployment they are skipped unless
 * `SWEEP_LOGINS` names a SUPERADMIN.
 */
const PLATFORM_PAGES = [
  "/platform",
  "/platform/organisations",
  "/platform/payments",
  "/platform/payments?tab=all",
  "/platform/payment-codes",
  "/platform/payment-codes?tab=used",
  "/platform/coupons",
  "/platform/password-resets",
  "/platform/audit",
  "/platform/notifications",
  "/platform/revenue",
  "/platform/settings",
];

const ROLES = ["ORG_OWNER", "ADMIN", "HR_MANAGER", "MANAGER", "TEAM_LEAD", "TEAM_MEMBER"] as const;

/**
 * Every signed-in page route, read off the filesystem.
 *
 * The list above is hand-written and went stale once already: it covered 30 of
 * 66 routes and none of the eight newest, which is the opposite of what a 404
 * guard is for. Rather than trusting whoever adds the next page to remember,
 * the routes are enumerated here and anything missing fails the run.
 */
function appRoutes(): string[] {
  const root = path.resolve("src/app/(app)");
  const found: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // A route group like (app) adds nesting without adding a path segment.
      const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : "/" + entry;
      const next = url + segment;
      if (readdirSync(full).includes("page.tsx")) found.push(next || "/");
      walk(full, next);
    }
  };
  walk(root, "");
  return found;
}

/** An [id] route needs a real row, or the sweep would 404 honestly. */
async function dynamicRoutes(): Promise<{ urls: string[]; patterns: string[] }> {
  if (SUPPLIED) return { urls: [], patterns: [] }; // No database reachable from here.
  const org = await prisma.organization.findFirst({ where: { slug: SLUG }, select: { id: true } });
  if (!org) return { urls: [], patterns: [] };
  const [employee, run, payment, exitRecord] = await Promise.all([
    prisma.employee.findFirst({ where: { organizationId: org.id }, select: { id: true } }),
    prisma.payrollRun.findFirst({ where: { organizationId: org.id }, select: { id: true } }),
    prisma.paymentOrder.findFirst({ where: { organizationId: org.id }, select: { id: true } }),
    prisma.exitRecord.findFirst({ where: { organizationId: org.id }, select: { id: true } }),
  ]);
  const urls: string[] = [];
  const patterns: string[] = [];
  const add = (row: { id: string } | null, base: string) => {
    if (!row) return;
    urls.push(base + "/" + row.id);
    patterns.push(base + "/[id]");
  };
  add(employee, "/employees");
  add(run, "/payroll");
  add(payment, "/billing");
  add(exitRecord, "/exit");
  return { urls, patterns };
}

const dynamic = await dynamicRoutes();
const covered = new Set([...PAGES, ...dynamic.patterns]);
const uncovered = appRoutes().filter((r) => !covered.has(r));
if (uncovered.length > 0) {
  console.log("\n  " + uncovered.length + " route(s) not swept:");
  for (const r of uncovered) {
    // Two different problems with two different fixes. A static route is simply
    // missing from the list; a dynamic one is missing a row to point at, and
    // adding it to PAGES would only ever sweep a literal "[id]".
    const why = r.includes("[")
      ? "no row in the seed to open it with - seed one, or extend dynamicRoutes()"
      : "add it to PAGES";
    console.log("    " + r + "  (" + why + ")");
  }
  console.log("");
}

const ALL = [...PAGES, ...dynamic.urls];


let broken = 0;
/** 5xx that did not reproduce -- reported, not counted. */
const flaky: string[] = [];
let checked = 0;

console.log(`\nSweeping ${BASE}\n`);

for (const role of ROLES) {
  const user = SUPPLIED
    ? (SUPPLIED.has(role) ? { email: SUPPLIED.get(role)! } : null)
    : await prisma.user.findFirst({
        where: { role, organization: { slug: SLUG } },
        select: { email: true },
      });
  if (!user) {
    console.log(`  ${role.padEnd(12)} no seeded user in "${SLUG}"`);
    broken++;
    continue;
  }

  // The limiter is 8 attempts per five minutes and this makes more than that.
  // It has its own tests; here it is only noise. Remotely there is no database
  // to reach, so five sign-ins have to fit inside the window instead.
  if (!SUPPLIED) await prisma.rateLimitCounter.deleteMany({});

  const signIn = () =>
    fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
  // Retried for the same reason the page fetches are: a dev server under three
  // hundred sequential requests drops one occasionally, and losing the run at
  // the fifth sign-in wastes the four roles already swept.
  let response: Response;
  try {
    response = await signIn();
  } catch {
    response = await signIn();
  }
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith("hrms_session="))
    ?.split(";")[0];

  if (!cookie) {
    console.log(`  ${role.padEnd(12)} ${user.email.padEnd(26)} SIGN-IN FAILED (${response.status})`);
    broken++;
    continue;
  }

  const problems: string[] = [];
  for (const page of ALL) {
    // One dropped connection used to end the whole run with an unhandled
    // ECONNRESET, three roles and fifteen minutes deep, reporting nothing about
    // the two hundred pages it had already checked. It happens repeatedly to a
    // dev server asked for three hundred pages in a row.
    //
    // The read is inside the retry, not just the request: the second time this
    // happened the socket died during `.text()`, which the first version of
    // this guard did not cover, and the run ended exactly as before.
    const load = async () => {
      const response = await fetch(`${BASE}${page}`, { headers: { cookie } });
      return { response, body: await response.text() };
    };
    let loaded: { response: Response; body: string };
    try {
      loaded = await load();
    } catch {
      try {
        loaded = await load();
      } catch (error) {
        problems.push(`${page} → unreachable (${(error as Error).message})`);
        checked++;
        continue;
      }
    }
    let page_response = loaded.response;
    let html = loaded.body;
    checked++;

    // A 5xx is retried once, and only a 5xx. This sweep runs against `next
    // dev`, which compiles a route the first time it is asked for, and a first
    // compile while the machine is busy can time out into a 500 on a page that
    // is perfectly fine -- `/billing` did exactly that once, then answered 200
    // twice in a row when asked directly. A real fault fails both times.
    //
    // The retry is reported rather than swallowed: "500 once" is noise on a dev
    // server and would be worth knowing on a real one, so it is not silently
    // turned into a pass.
    if (page_response.status >= 500) {
      const second = await load().catch(() => null);
      if (second && second.response.status < 500) {
        flaky.push(`${page} (${page_response.status}, then ${second.response.status})`);
        page_response = second.response;
        html = second.body;
      }
    }

    if (page_response.status >= 500) {
      problems.push(`${page} → ${page_response.status}`);
    } else if (html.includes("Application error")) {
      problems.push(`${page} → client error`);
    } else if (
      page_response.status === 404 &&
      // A 404 rendering one of our own screens is the product refusing on
      // purpose: the permission screen, or the not-found screen a scoped
      // record reaches when it is somebody else's. A 404 rendering Next's
      // bare default is a link pointing at a page that does not exist, which
      // is the only one of the three worth reporting.
      //
      // Matched on the marker rather than the copy, and without a trailing
      // "=": the screen arrives as an RSC payload where the attribute is
      // serialised as \"data-notfound\":\"app\". Matching the prose was worse
      // still -- React escapes the apostrophe in one of the two pages.
      !html.includes("do not have access") &&
      !html.includes("data-notfound")
    ) {
      problems.push(`${page} → 404, no page`);
    }
  }

  console.log(
    `  ${role.padEnd(12)} ${user.email.padEnd(26)} ${problems.length === 0 ? "all clean" : problems.join(", ")}`,
  );
  broken += problems.length;
}

broken += uncovered.length;

/**
 * The platform console and the kiosk, which the role loop above never reaches.
 */
async function sweepAs(label: string, email: string | null, password: string, pages: string[]) {
  if (!email) {
    console.log(`  ${label.padEnd(12)} skipped (no account)`);
    return;
  }
  if (!SUPPLIED) await prisma.rateLimitCounter.deleteMany({});
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith("hrms_session="))
    ?.split(";")[0];
  if (!cookie) {
    console.log(`  ${label.padEnd(12)} ${email.padEnd(26)} SIGN-IN FAILED (${response.status})`);
    broken++;
    return;
  }
  const problems: string[] = [];
  for (const page of pages) {
    let html = "";
    let status = 0;
    try {
      const r = await fetch(`${BASE}${page}`, { headers: { cookie } });
      status = r.status;
      html = await r.text();
    } catch (error) {
      problems.push(`${page} → unreachable (${(error as Error).message})`);
      checked++;
      continue;
    }
    checked++;
    if (status >= 500) problems.push(`${page} → ${status}`);
    else if (html.includes("Application error") || html.includes("Something went wrong")) {
      problems.push(`${page} → error screen`);
    }
  }
  console.log(
    `  ${label.padEnd(12)} ${email.padEnd(26)} ${problems.length === 0 ? "all clean" : problems.join(", ")}`,
  );
  broken += problems.length;
  return cookie;
}

const superadminEmail = SUPPLIED
  ? (SUPPLIED.get("SUPERADMIN") ?? null)
  : (process.env.SUPERADMIN_EMAIL ?? null);
await sweepAs(
  "SUPERADMIN",
  superadminEmail,
  process.env.SUPERADMIN_PASSWORD ?? PASSWORD,
  PLATFORM_PAGES,
);

const kiosk = SUPPLIED
  ? null
  : await prisma.user.findFirst({
      where: { role: "KIOSK", organization: { slug: SLUG } },
      select: { id: true, email: true },
    });
// A device account is minted with a generated password nobody keeps. This is
// the seed database; the device gets the seed password for the sweep.
if (kiosk) {
  await prisma.user.update({ where: { id: kiosk.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
}
await sweepAs("KIOSK", kiosk?.email ?? null, PASSWORD, ["/kiosk"]);

/**
 * A dead session, on a soft navigation.
 *
 * This is the failure the owner reported and the one no full-page sweep can
 * see: the layout's login redirect does not run for a client-side navigation,
 * so a page that asked for its context directly threw into the error
 * boundary. Here the owner's session is signed out server-side and every page
 * is requested the way the router requests it -- with the `RSC` header and the
 * stale cookie -- and the answer must be a redirect to the login screen, never
 * a rendered fault (which arrives in the flight payload as a `digest`).
 */
{
  const owner = SUPPLIED
    ? (SUPPLIED.has("ORG_OWNER") ? { email: SUPPLIED.get("ORG_OWNER")! } : null)
    : await prisma.user.findFirst({
        where: { role: "ORG_OWNER", organization: { slug: SLUG } },
        select: { email: true },
      });
  if (owner) {
    if (!SUPPLIED) await prisma.rateLimitCounter.deleteMany({});
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith("hrms_session="))
      ?.split(";")[0];
    if (cookie) {
      await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
      const problems: string[] = [];
      for (const page of ALL) {
        try {
          const r = await fetch(`${BASE}${page}`, {
            headers: { cookie, RSC: "1" },
            redirect: "manual",
          });
          const body = await r.text();
          checked++;
          // For an RSC request Next answers a `redirect()` with a 200 whose
          // flight body carries `NEXT_REDIRECT;replace;/login;307;` as a
          // digest -- so a redirect and a fault both look like "a digest",
          // and the one is told from the other by what the digest says.
          const redirected =
            r.status === 307 ||
            r.status === 303 ||
            /NEXT_REDIRECT;(replace|push);\/login/.test(body);
          if (!redirected && (body.includes('"digest"') || body.includes("Something went wrong"))) {
            problems.push(`${page} → error boundary`);
          } else if (!redirected) {
            problems.push(`${page} → ${r.status}, no redirect`);
          }
        } catch (error) {
          problems.push(`${page} → unreachable (${(error as Error).message})`);
        }
      }
      console.log(
        `  ${"DEAD SESSION".padEnd(12)} ${"soft navigation".padEnd(26)} ${problems.length === 0 ? "all go to login" : problems.join(", ")}`,
      );
      broken += problems.length;
    }
  }
}

if (flaky.length > 0) {
  console.log(`
  ${flaky.length} page(s) 500ed once and were fine on a retry:`);
  for (const f of flaky) console.log(`    ${f}`);
  console.log("  Expected against `next dev`; investigate if it happens against a build.");
}
console.log(`\n  ${checked} page loads, ${broken} broken\n`);
if (!SUPPLIED) await prisma.$disconnect();
process.exit(broken === 0 ? 0 : 1);
