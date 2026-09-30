import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every reader of a leave allocation goes through `resolveAllocation`.
 *
 * The bug this guards against was not bad arithmetic. `DesignationLeaveAllocation`
 * existed, a settings screen edited it, and **nothing else in the product read
 * it**: the employee's own leave screen, the balance grid, the year-end
 * carry-forward run, the full-and-final settlement and the leave-balances
 * report all took `LeaveType.annualAllocation`, the one number for the whole
 * company. So an administrator could set a manager to eighteen days of casual
 * leave and a trainee to none, see exactly that on the screen that set it, and
 * then watch both of them accrue, spend and get encashed on twelve.
 *
 * There is no pure function that can be tested into this shape — the defect is
 * which columns four services fetch — so these read the source. Each assertion
 * is one of the four readers still asking the resolver rather than the leave
 * type, and each of them going back to `LeaveType.annualAllocation` on its own
 * is what would put the four back out of step with each other.
 */

const read = (file: string) => readFileSync(path.resolve(file), "utf8");

/** Comments stripped, so a rule quoted in prose cannot pass for a rule in code. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const LEAVE = strip(read("src/services/leave/index.ts"));
const BALANCES = strip(read("src/services/leave/balances.ts"));
const FNF = strip(read("src/services/exit/fnf.ts"));
const REPORTS = strip(read("src/services/reports/index.ts"));
const RESOLVER = strip(read("src/domain/leave/allocation.ts"));

const READERS: [string, string][] = [
  ["the employee's own leave screen", LEAVE],
  ["the balance grid and the year-end run", BALANCES],
  ["the full-and-final settlement", FNF],
  ["the leave-balances report", REPORTS],
];

describe("the resolver is the only place the precedence is written", () => {
  it("puts the person's own figure first, then the designation, then the type", () => {
    // Read as code rather than trusted from the doc comment: this single
    // expression is the whole policy, and any reader below inherits it.
    expect(RESOLVER).toMatch(
      /allocationDays\(layers\.personal\)\s*\?\?\s*allocationDays\(layers\.designation\)\s*\?\?\s*allocationDays\(layers\.type\)/,
    );
  });

  it("never turns an unset layer into zero days", () => {
    // `Number(null)` is 0 and finite. If `allocationDays` stopped returning
    // null for an absent layer, a designation nobody had set would read as
    // "this role gets none" — and that figure is what caps accrual, what a
    // leave request is validated against and what a settlement encashes.
    expect(RESOLVER).toMatch(/if \(value === null \|\| value === undefined\) return null;/);
    expect(RESOLVER).toMatch(/if \(!Number\.isFinite\(days\) \|\| days < 0\) return null;/);
  });
});

describe("every reader consults the designation", () => {
  for (const [what, source] of READERS) {
    it(`${what} imports the resolver`, () => {
      expect(source).toMatch(/from "@\/domain\/leave\/allocation"/);
      expect(source).toMatch(/\bresolveAllocation\b/);
    });

    it(`${what} actually fetches the per-designation rows`, () => {
      // Importing the resolver is not enough: without this query there is
      // nothing to resolve and the call quietly returns the company figure.
      expect(source).toMatch(/prisma\.designationLeaveAllocation\.find(Many|First)\(/);
    });

    it(`${what} knows which designation the employee holds`, () => {
      expect(source).toMatch(/designationId: true/);
    });

    it(`${what} calls the resolver rather than reimplementing the ladder`, () => {
      expect(source).toMatch(/resolveAllocation\(\{/);
    });
  }
});

describe("the accrual cap is the resolved figure, not the leave type's", () => {
  it("on the employee's own leave screen", () => {
    // `accruedSoFar` caps a MONTHLY type at its annual allocation. Feeding it
    // the company figure is how a designation with fewer days than the company
    // still accrued the company's — which is the same as not having a
    // designation allocation at all.
    expect(LEAVE).toMatch(
      /const entitlement = resolveAllocation\(\{ designation, type: type\.annualAllocation \}\)/,
    );
    expect(LEAVE).toMatch(/annualAllocation: entitlement/);
  });

  it("in the full-and-final settlement", () => {
    expect(FNF).toMatch(/annualAllocation: resolveAllocation\(\{\s*designation,/);
  });

  it("in the leave-balances report", () => {
    expect(REPORTS).toMatch(/annualAllocation: resolveAllocation\(\{\s*designation,/);
  });

  it("in the balance grid, the adjust dialog and the year-end run alike", () => {
    // Three separate resolutions, because the three ask about different
    // employees: the grid resolves per row, `adjustBalance` for the one person
    // it is editing, and `runCarryForward` per person via `typeFor`.
    const calls = BALANCES.match(/resolveAllocation\(\{/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(BALANCES).toMatch(/const typeFor = \(type: TypeShape & \{ id: string \}/);
  });

  it("never hands the unresolved type to the accrual helpers in the balance service", () => {
    // `accrualOf` and `impliedState` both read `type.annualAllocation`
    // literally. They are only correct because every call site passes a type
    // whose allocation has already been resolved — `rawType` reaching either of
    // them is the exact regression this file exists to catch.
    for (const call of BALANCES.match(/\b(accrualOf|impliedState)\([^)]*/g) ?? []) {
      expect(call, call).not.toMatch(/\brawType\b/);
    }
    expect(BALANCES).toMatch(/\baccrualOf\(/);
    expect(BALANCES).toMatch(/\bimpliedState\(/);
  });
});

describe("an approval does not freeze the company figure into the personal layer", () => {
  it("resolves before creating the balance row", () => {
    // The first approval of the year is what creates a `LeaveBalance`, and
    // `allocated` on that row outranks the designation from then on. Writing
    // `request.leaveType.annualAllocation` there did not merely show the wrong
    // number once — it overwrote the designation's answer for the rest of the
    // year the moment somebody took a single day off.
    expect(LEAVE).not.toMatch(/allocated: request\.leaveType\.annualAllocation/);
    expect(LEAVE).toMatch(/const allocated = resolveAllocation\(\{/);
    expect(LEAVE).toMatch(/type: request\.leaveType\.annualAllocation/);
  });

  it("scopes that lookup to the caller's own organisation", () => {
    // A designation id read off the employee is trusted, but the row fetched
    // for it is still tenant-scoped: a cross-tenant row must not be able to
    // decide what this organisation grants.
    const lookup = LEAVE.slice(LEAVE.indexOf("prisma.designationLeaveAllocation.findFirst"));
    expect(lookup.slice(0, 400)).toMatch(/organizationId: ctx\.organizationId/);
  });
});

describe("the personal override still wins", () => {
  it("is passed as the first layer wherever a stored row is in hand", () => {
    // The finest layer, and the one that must survive this change: an employee
    // whose contract says something different from their designation keeps it.
    expect(LEAVE).toMatch(/personal: balance\?\.allocated/);
    expect(FNF).toMatch(/personal: b\.allocated/);
    expect(REPORTS).toMatch(/personal: b\.allocated/);
    // The grid reads a stored row's `allocated` directly and only falls back to
    // the resolved type when no row exists, which is the same precedence
    // reached the other way round.
    expect(BALANCES).toMatch(/allocated: Number\(row\.allocated\)/);
  });
});
