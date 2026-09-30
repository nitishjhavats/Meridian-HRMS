import { describe, expect, it } from "vitest";

import { NOT_APPLICABLE } from "@/domain/letters/template";
import { frameworkChanged, renderFrameworkPreview, type EditableFramework } from "./framework";

/**
 * Two things the template editor got wrong, one on each side of the screen.
 *
 * On the left, Save only lit up when the wording changed: a signatory typed in
 * or "Sign this letter" switched off with the text untouched was greyed out
 * and lost. On the right, Preview asked the server for the rendered text, and
 * the server only has the saved version -- so an edit did not show until after
 * it was saved, which is the wrong way round for a preview.
 */

const stored: EditableFramework = {
  subject: "Offer of employment",
  header: "Private and confidential",
  body: "Dear {{employee.name}},\n\nWe are pleased to offer you {{employee.designation}}.",
  footer: "{{organization.name}}",
  showLogo: true,
  showSignature: true,
  showStamp: true,
  signatory: { name: null, title: null },
};

describe("frameworkChanged", () => {
  it("is false when nothing has been touched", () => {
    expect(frameworkChanged({ ...stored }, stored)).toBe(false);
  });

  it("still notices the wording", () => {
    expect(frameworkChanged({ ...stored, body: `${stored.body} Welcome.` }, stored)).toBe(true);
    expect(frameworkChanged({ ...stored, subject: "Offer" }, stored)).toBe(true);
  });

  it("notices a signatory typed in with the wording untouched", () => {
    // The report: type a name into "Signed by", Save stays greyed out.
    expect(
      frameworkChanged({ ...stored, signatory: { name: "Priya Sharma", title: null } }, stored),
    ).toBe(true);
    expect(
      frameworkChanged({ ...stored, signatory: { name: null, title: "Head of People" } }, stored),
    ).toBe(true);
  });

  it("notices a switch flipped with the wording untouched", () => {
    expect(frameworkChanged({ ...stored, showSignature: false }, stored)).toBe(true);
    expect(frameworkChanged({ ...stored, showStamp: false }, stored)).toBe(true);
    expect(frameworkChanged({ ...stored, showLogo: false }, stored)).toBe(true);
  });

  it("treats a blank signatory as the stored null, since that is what Save writes", () => {
    // The input turns null into "" the moment it renders; a name typed and
    // deleted again is "   " at worst. Neither is a change worth saving.
    expect(frameworkChanged({ ...stored, signatory: { name: "", title: "  " } }, stored)).toBe(
      false,
    );
    // And a name cleared is a change, however it is spelt.
    const named = { ...stored, signatory: { name: "Priya Sharma", title: null } };
    expect(frameworkChanged({ ...named, signatory: { name: "", title: null } }, named)).toBe(true);
  });
});

describe("renderFrameworkPreview", () => {
  const values = {
    "employee.name": "Asha Verma",
    "employee.designation": "Engineer",
    "organization.name": "Acme",
    "signatory.name": "Ravi Menon",
    "signatory.title": "Director",
  };

  it("renders the draft in the editor, not the saved framework", () => {
    const edited = { ...stored, body: "Dear {{employee.name}}, you start on {{employee.joiningDate}}." };
    const preview = renderFrameworkPreview(edited, values);
    expect(preview.body.text).toBe("Dear Asha Verma, you start on [Joining date].");
    expect(preview.body.problems.map((p) => p.key)).toEqual(["employee.joiningDate"]);
    expect(preview.subject).toBe("Offer of employment");
    expect(preview.header.text).toBe("Private and confidential");
    expect(preview.footer.text).toBe("Acme");
  });

  it("lets a signatory typed in the editor win over the resolved one", () => {
    const draft = {
      ...stored,
      body: "Signed, {{signatory.name}}, {{signatory.title}}",
      signatory: { name: "Priya Sharma", title: "" },
    };
    const preview = renderFrameworkPreview(draft, values);
    // The name is the editor's; the blank title falls back to what the server resolved.
    expect(preview.body.text).toBe("Signed, Priya Sharma, Director");
  });

  it("shows the labels when there is nobody to fill it for", () => {
    const preview = renderFrameworkPreview(stored, {});
    expect(preview.body.text).toContain("[Employee name]");
    expect(preview.body.problems).toHaveLength(2);
  });

  it("keeps the server's not-applicable rule, since it is the same renderer", () => {
    const draft = {
      ...stored,
      body: "Dear {{employee.name}},\n\nPF code {{organization.pfCode}} applies.\n\nRegards.",
    };
    const preview = renderFrameworkPreview(draft, { ...values, "organization.pfCode": NOT_APPLICABLE });
    expect(preview.body.text).toBe("Dear Asha Verma,\n\nRegards.");
    expect(preview.body.problems).toEqual([]);
  });
});
