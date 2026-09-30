import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CHECK_FIELDS, describeIssues, fieldIssuesFrom, issueFor } from "./fieldIssues";

/**
 * Every zod refusal reached the screen as "Please check the highlighted
 * fields." with nothing highlighted: the issues were in the envelope and no
 * form outside the payroll rule editor read them. The message names the first
 * field now, and a form that wants the error under the box asks `issueFor`.
 */

const issues = (...pairs: [string, string][]) => pairs.map(([path, message]) => ({ path, message }));

describe("describeIssues", () => {
  it("names the first field and quotes what zod said", () => {
    expect(describeIssues(issues(["name", "String must contain at least 2 character(s)"]))).toBe(
      "Please check name: String must contain at least 2 character(s).",
    );
  });

  it("keeps the punctuation a custom message already carries", () => {
    expect(describeIssues(issues(["email", "That is not an email address."]))).toBe(
      "Please check email: That is not an email address.",
    );
  });

  it("names a nested field by its path", () => {
    expect(describeIssues(issues(["devices.0.label", "Too short"]))).toMatch(
      /^Please check devices\.0\.label: Too short\./,
    );
  });

  it("counts the rest, so fixing one and being refused again is no surprise", () => {
    expect(describeIssues(issues(["name", "Required"], ["phone", "Too long"]))).toBe(
      "Please check name: Required. And 1 other field.",
    );
    expect(
      describeIssues(issues(["name", "Required"], ["phone", "Too long"], ["email", "Invalid"])),
    ).toMatch(/And 2 other fields\.$/);
  });

  it("says what was said when no field is named", () => {
    // A union that matched nothing reports at the root.
    expect(describeIssues(issues(["", "Invalid input"]))).toBe(
      "Please check what you entered: Invalid input.",
    );
  });

  it("falls back to the old line with nothing to say", () => {
    expect(describeIssues([])).toBe(CHECK_FIELDS);
  });
});

describe("issueFor", () => {
  const list = issues(["address.line1", "Required"], ["name", "Too short"], ["name", "Later"]);

  it("gives the first issue against the field", () => {
    expect(issueFor(list, "name")).toBe("Too short");
  });

  it("reaches a nested issue through the box that holds it", () => {
    expect(issueFor(list, "address")).toBe("Required");
  });

  it("is nothing for a field the schema did not mention", () => {
    expect(issueFor(list, "phone")).toBeUndefined();
    // A prefix is not a field: `name` must not answer for `names`.
    expect(issueFor(list, "nam")).toBeUndefined();
  });
});

describe("fieldIssuesFrom", () => {
  it("flattens zod's path to the dotted form the client binds to", () => {
    const parsed = z
      .object({ name: z.string().min(2), devices: z.array(z.object({ label: z.string().min(2) })) })
      .safeParse({ name: "a", devices: [{ label: "x" }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(fieldIssuesFrom(parsed.error.issues).map((i) => i.path)).toEqual([
      "name",
      "devices.0.label",
    ]);
  });
});
