import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Things that were built and cannot be reached.
 *
 * This codebase keeps growing them. Planning one round turned up seventeen
 * without looking: a payroll rule the engine implemented and no screen could
 * set, a goal edit path with no caller, a leave-type model with no UI at all, a
 * calendar button in the corner of a card two thirds down a page, a sample
 * payslip behind data nobody had. Every one of them passed the type checker,
 * the tests and the layout rules, because none of those ask whether a person
 * can get to it.
 *
 * So this asks. It is deliberately dumb — text over the source tree, no AST —
 * because the failure it catches is coarse and a clever version would be a
 * second thing to maintain. What it costs is that it can be wrong, which is why
 * every finding can be waived **in the source, beside the declaration**, with
 * `@unreachable-ok <reason>`. A waiver with no reason is refused.
 *
 *   npm run verify:reachability
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const findings: Finding[] = [];

/* -------------------------------------------------------------------------- */
/*  Reading the tree                                                           */
/* -------------------------------------------------------------------------- */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const sources = new Map<string, string>();
for (const file of files) sources.set(file, readFileSync(file, "utf8"));

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const isTest = (file: string) => /\.test\.tsx?$/.test(file);

/** Comments stripped, so a mention in prose is not a use. */
function code(file: string): string {
  return (sources.get(file) ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Everything except the file itself and the tests. A test is not a caller. */
function elsewhere(file: string): string {
  let joined = "";
  for (const other of files) {
    if (other === file || isTest(other)) continue;
    joined += code(other);
  }
  return joined;
}

function lineOf(file: string, needle: string): number {
  const lines = (sources.get(file) ?? "").split(/\r?\n/);
  const index = lines.findIndex((l) => l.includes(needle));
  return index === -1 ? 1 : index + 1;
}

/**
 * A waiver written beside the thing it waives.
 *
 * Within ten lines above the declaration, so it cannot drift to the top of the
 * file and cover everything. The reason is required: "@unreachable-ok" on its
 * own tells the next reader nothing, and this whole script exists because
 * somebody could not tell whether a thing was deliberate.
 */
function waived(file: string, needle: string): boolean {
  const lines = (sources.get(file) ?? "").split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(needle));
  if (at === -1) return false;
  const window = lines.slice(Math.max(0, at - 10), at + 1).join("\n");
  const match = /@unreachable-ok\s+(.+)/.exec(window);
  return Boolean(match && (match[1] ?? "").trim().length >= 8);
}

/* -------------------------------------------------------------------------- */
/*  1 — exported service functions nobody calls                                */
/* -------------------------------------------------------------------------- */

const EXPORTED_FN = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;

for (const file of files) {
  if (isTest(file)) continue;
  const relative = rel(file);
  if (!relative.startsWith("src/services/")) continue;

  const body = code(file);
  const others = elsewhere(file);

  for (const match of body.matchAll(EXPORTED_FN)) {
    const name = match[1];
    if (!name) continue;
    if (others.includes(name)) continue;

    /**
     * Used inside its own file is used.
     *
     * The first version of this rule flagged eleven helpers that a public
     * function in the same file calls -- `planCarryForward`, `resolveSignatory`,
     * `statusForMissingAttendance` and the rest -- which are exported so a test
     * can reach them directly. That is a real pattern here and not a defect;
     * flagging it would have buried the seven findings that matter under
     * eleven that do not, which is how a checker teaches people to skip its
     * output.
     *
     * What is left is the thing worth catching: a whole capability that no
     * screen and no route can get to.
     */
    const usedInFile = (body.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length > 1;
    if (usedInFile) continue;
    if (waived(file, `function ${name}`)) continue;

    findings.push({
      file: relative,
      line: lineOf(file, `function ${name}`),
      rule: "service function has no caller",
      detail: `${name}() is exported and nothing outside its own file and tests uses it — wire it to a route, or delete it`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  2 — API routes nothing fetches                                             */
/* -------------------------------------------------------------------------- */

for (const file of files) {
  const relative = rel(file);
  const match = /^src\/app\/(api\/.+)\/route\.ts$/.exec(relative);
  if (!match?.[1]) continue;

  // "/api/payroll/items/[id]/payments" -> the literal part before the first
  // dynamic segment, which is what a fetch string starts with.
  const url = `/${match[1]}`;
  const literal = url.split("/[")[0] ?? url;
  if (literal.length < 6) continue;

  const others = elsewhere(file);
  // A route may also be opened as a link or a form action rather than fetched.
  if (others.includes(literal)) continue;
  if (waived(file, "export const")) continue;

  findings.push({
    file: relative,
    line: 1,
    rule: "route has no caller",
    detail: `nothing in src/ mentions ${literal} — it can only be reached by typing the address`,
  });
}

/* -------------------------------------------------------------------------- */
/*  3 — permissions nothing checks                                             */
/* -------------------------------------------------------------------------- */

const PERMISSIONS_FILE = path.join(SRC, "lib", "auth", "permissions.ts");
const permissionsSource = sources.get(PERMISSIONS_FILE) ?? "";
const declared = [...permissionsSource.matchAll(/^\s*"([a-z][a-z0-9.]*\.[a-z0-9.]+)",/gm)]
  .map((m) => m[1])
  .filter((p): p is string => Boolean(p));

const everythingElse = files
  .filter((f) => f !== PERMISSIONS_FILE && !isTest(f))
  .map((f) => code(f))
  .join("");

for (const permission of new Set(declared)) {
  if (everythingElse.includes(`"${permission}"`)) continue;
  if (waived(PERMISSIONS_FILE, `"${permission}",`)) continue;

  findings.push({
    file: rel(PERMISSIONS_FILE),
    line: lineOf(PERMISSIONS_FILE, `"${permission}",`),
    rule: "permission gates nothing",
    detail: `${permission} is granted to roles and checked nowhere — it reads as a capability the product does not have`,
  });
}

/* -------------------------------------------------------------------------- */
/*  4 — Prisma columns nothing reads                                           */
/* -------------------------------------------------------------------------- */

/**
 * Only scalar columns on models the product writes, and only where the name is
 * distinctive enough to search for. `id`, `name` and `createdAt` appear
 * everywhere and mean nothing here, so they are skipped rather than producing
 * noise that trains people to ignore the output.
 */
const COMMON = new Set([
  "id",
  "name",
  "code",
  "date",
  "status",
  "type",
  "note",
  "notes",
  "value",
  "label",
  "title",
  "active",
  "paid",
  "year",
  "month",
  "createdAt",
  "updatedAt",
  "createdById",
  "organizationId",
  "employeeId",
  "userId",
]);

const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
const allSource = files.map((f) => code(f)).join("");

/**
 * A column is waived by the `///` doc comment immediately above it.
 *
 * Immediately, not within ten lines: a Prisma model is a list of one-line
 * fields, and a waiver that reached back further would cover its neighbours.
 */
const schemaLines = schema.split(/\r?\n/);
function columnWaived(declaration: string): boolean {
  const at = schemaLines.findIndex((l) => l === declaration);
  if (at <= 0) return false;
  const above = schemaLines[at - 1] ?? "";
  const match = /@unreachable-ok\s+(.+)/.exec(above);
  return Boolean(match && (match[1] ?? "").trim().length >= 8);
}

for (const model of schema.split(/\nmodel /).slice(1)) {
  const modelName = (model.split(/\s/)[0] ?? "").trim();
  const body = model.slice(0, model.indexOf("\n}"));

  for (const line of body.split(/\r?\n/)) {
    const field = /^\s{2}([a-z][A-Za-z0-9]*)\s+(String|Int|Boolean|DateTime|Decimal|Json|Float)\b/.exec(
      line,
    );
    const column = field?.[1];
    if (!column || COMMON.has(column)) continue;
    if (line.includes("@relation")) continue;
    if (allSource.includes(column)) continue;
    if (columnWaived(line)) continue;

    findings.push({
      file: "prisma/schema.prisma",
      line: 1,
      rule: "column is never read",
      detail: `${modelName}.${column} is stored and nothing in src/ mentions it`,
    });
  }
}

/* -------------------------------------------------------------------------- */

if (findings.length === 0) {
  console.log("\nReachability: clean.\n");
  process.exit(0);
}

console.log(`\n${findings.length} reachability finding(s):\n`);
for (const finding of findings) {
  console.log(`  ${finding.file}:${finding.line}`);
  console.log(`    ${finding.rule} — ${finding.detail}\n`);
}
console.log(
  "Each is one of three things: wire it up, delete it, or write `@unreachable-ok <reason>`\n" +
    "in a comment beside the declaration saying why it is deliberate.\n",
);
process.exit(1);
