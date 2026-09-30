import { describe, expect, it } from "vitest";
import {
  NOT_APPLICABLE,
  canIssue,
  extractPlaceholders,
  nextLetterNumber,
  renderTemplate,
} from "./template";

const values = {
  "employee.name": "Sneha Patil",
  "employee.designation": "Software Engineer",
  "organization.name": "Acme Technologies",
  "salary.monthlyCtc": "₹55,000.00",
};

describe("renderTemplate", () => {
  it("substitutes known placeholders", () => {
    const result = renderTemplate("Dear {{employee.name}}, welcome to {{organization.name}}.", values);
    expect(result.text).toBe("Dear Sneha Patil, welcome to Acme Technologies.");
    expect(result.problems).toEqual([]);
  });

  it("tolerates any spacing inside the braces", () => {
    expect(renderTemplate("Hi {{  employee.name  }}", values).text).toBe("Hi Sneha Patil");
  });

  it("substitutes every occurrence, not just the first", () => {
    const result = renderTemplate("{{employee.name}} … {{employee.name}}", values);
    expect(result.text).toBe("Sneha Patil … Sneha Patil");
    expect(result.used).toEqual(["employee.name"]);
  });

  it("flags an unknown placeholder and leaves it visible", () => {
    const result = renderTemplate("Your {{employee.favouriteColour}} is noted.", values);
    expect(result.problems[0]?.kind).toBe("UNKNOWN");
    // Left in place so the author can see exactly where the mistake is.
    expect(result.text).toContain("{{employee.favouriteColour}}");
  });

  it("never renders the word undefined for a missing value", () => {
    const result = renderTemplate("Salary: {{salary.annualCtc}}", values);
    expect(result.text).toBe("Salary: [Annual salary]");
    expect(result.text).not.toContain("undefined");
    expect(result.problems[0]?.kind).toBe("MISSING");
  });

  it("treats an empty string as missing, not as a value", () => {
    const result = renderTemplate("Hi {{employee.name}}", { "employee.name": "" });
    expect(result.problems[0]?.kind).toBe("MISSING");
  });

  it("leaves text with no placeholders untouched", () => {
    const plain = "This letter has nothing to fill in.";
    expect(renderTemplate(plain, values).text).toBe(plain);
  });
});

describe("canIssue", () => {
  it("permits a fully resolved letter", () => {
    expect(canIssue(renderTemplate("Dear {{employee.name}}", values))).toBe(true);
  });

  it("blocks a letter with a gap in it", () => {
    // An offer letter printed with "[Annual salary]" must never be issuable.
    expect(canIssue(renderTemplate("You will earn {{salary.annualCtc}}", values))).toBe(false);
  });

  it("blocks a letter with an unknown placeholder", () => {
    expect(canIssue(renderTemplate("{{made.up}}", values))).toBe(false);
  });
});

describe("extractPlaceholders", () => {
  it("lists each placeholder once, in order", () => {
    expect(
      extractPlaceholders("{{b.one}} {{a.two}} {{b.one}}"),
    ).toEqual(["b.one", "a.two"]);
  });

  it("returns nothing for plain text", () => {
    expect(extractPlaceholders("no tokens here")).toEqual([]);
  });
});

describe("nextLetterNumber", () => {
  it("starts at one for a fresh year", () => {
    expect(nextLetterNumber("OFR", 2026, null)).toBe("OFR/2026/0001");
  });

  it("continues the sequence", () => {
    expect(nextLetterNumber("OFR", 2026, "OFR/2026/0007")).toBe("OFR/2026/0008");
  });

  it("restarts when the year rolls over", () => {
    expect(nextLetterNumber("OFR", 2027, "OFR/2026/0099")).toBe("OFR/2027/0001");
  });

  it("does not carry a sequence across prefixes", () => {
    expect(nextLetterNumber("EXP", 2026, "OFR/2026/0042")).toBe("EXP/2026/0001");
  });

  it("pads past four digits rather than truncating", () => {
    expect(nextLetterNumber("LTR", 2026, "LTR/2026/9999")).toBe("LTR/2026/10000");
  });
});

describe("a placeholder used twice", () => {
  it("is reported once, not once per occurrence", () => {
    // The composer renders one input per problem. Two problems for one key gave
    // two fields with the same DOM id and the same React key, both bound to the
    // same value -- and `{{organization.name}}` appears twice in the shipped
    // Offer default and three times in the Appointment one.
    const result = renderTemplate(
      "{{organization.name}} — {{organization.name}} — {{organization.name}}",
      {},
    );
    expect(result.problems.filter((p) => p.key === "organization.name")).toHaveLength(1);
  });

  it("still substitutes every occurrence", () => {
    const result = renderTemplate("{{employee.name}} and {{employee.name}}", {
      "employee.name": "Sneha Patil",
    });
    expect(result.text).toBe("Sneha Patil and Sneha Patil");
    expect(result.problems).toHaveLength(0);
  });

  it("reports an unknown placeholder once too", () => {
    const result = renderTemplate("{{nope}} {{nope}}", {});
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.kind).toBe("UNKNOWN");
  });
});

describe("a value that does not apply", () => {
  const TEMPLATE = [
    "Dear {{employee.name}},",
    "We confirm your appointment at {{organization.name}}.",
    "Provident fund contributions are made under establishment code {{organization.pfCode}}.",
    "Please sign and return the enclosed copy.",
  ].join("\n\n");

  const BASE = {
    "employee.name": "Asha Rao",
    "organization.name": "Acme",
  };

  it("drops the whole paragraph, not just the placeholder", () => {
    // Blanking the placeholder alone would leave "under establishment code ."
    // on a document somebody signs.
    const rendered = renderTemplate(TEMPLATE, {
      ...BASE,
      "organization.pfCode": NOT_APPLICABLE,
    });
    expect(rendered.text).not.toContain("establishment code");
    expect(rendered.text).not.toContain("Provident fund");
    expect(rendered.text).toContain("We confirm your appointment at Acme.");
    expect(rendered.text).toContain("Please sign and return the enclosed copy.");
  });

  it("leaves the surviving paragraphs correctly separated", () => {
    const rendered = renderTemplate(TEMPLATE, {
      ...BASE,
      "organization.pfCode": NOT_APPLICABLE,
    });
    expect(rendered.text.split("\n\n")).toHaveLength(3);
    expect(rendered.text).not.toContain("\n\n\n");
  });

  it("is not a problem, so the letter can still be issued", () => {
    const rendered = renderTemplate(TEMPLATE, {
      ...BASE,
      "organization.pfCode": NOT_APPLICABLE,
    });
    expect(rendered.problems).toEqual([]);
    expect(canIssue(rendered)).toBe(true);
  });

  it("still blocks when the value is merely missing", () => {
    // The distinction this whole feature turns on: PF switched off drops the
    // clause; PF on with no code filled in must stop the letter.
    const rendered = renderTemplate(TEMPLATE, { ...BASE, "organization.pfCode": null });
    expect(rendered.text).toContain("establishment code");
    expect(rendered.problems.map((p) => p.kind)).toEqual(["MISSING"]);
    expect(canIssue(rendered)).toBe(false);
  });

  it("keeps the dropped placeholder in `used`, so the editor still lists it", () => {
    // `used` builds the fill-in form from the *template*. A placeholder that
    // does not apply to one organisation must not disappear from the editor.
    const rendered = renderTemplate(TEMPLATE, {
      ...BASE,
      "organization.pfCode": NOT_APPLICABLE,
    });
    expect(rendered.used).toContain("organization.pfCode");
  });

  it("removes every paragraph that mentions it, not only the first", () => {
    const twice = [
      "One.",
      "PF code {{organization.pfCode}}.",
      "Two.",
      "Also PF {{organization.pfCode}}.",
    ].join("\n\n");
    const rendered = renderTemplate(twice, { "organization.pfCode": NOT_APPLICABLE });
    expect(rendered.text).toBe("One.\n\nTwo.");
  });

  it("does not take a paragraph out for a value that is present", () => {
    const rendered = renderTemplate(TEMPLATE, { ...BASE, "organization.pfCode": "PN/1234" });
    expect(rendered.text).toContain("establishment code PN/1234");
    expect(rendered.text.split("\n\n")).toHaveLength(4);
  });
});
