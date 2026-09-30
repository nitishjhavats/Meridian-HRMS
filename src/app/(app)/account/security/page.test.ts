import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Download my data" is a plain `<a download>` to `/api/me/export`, which is
 * right when there is a record to download and silent when there is not: the
 * service refuses a login with no employee record with a 422, and a browser
 * treats a 422 behind `download` as a failed download — a "Server problem"
 * entry in the downloads bar, nothing on the page. An owner of an older
 * organisation, whose login predates owners being added to the directory,
 * clicked and saw nothing happen.
 *
 * So the page only offers the link when there is somebody to export, and
 * otherwise says what every other screen says about a login without a record.
 */

const PAGE = "src/app/(app)/account/security/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("/account/security for a login with no employee record", () => {
  const body = code(PAGE);

  it("offers the download only when there is a record to download", () => {
    const branch = body.indexOf("{ctx.employeeId ? (");
    const link = body.indexOf('href="/api/me/export"');
    expect(branch).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(branch);
  });

  it("otherwise says so in the words the rest of the app uses", () => {
    expect(body).toContain('title="Your login is not linked to an employee record"');
  });

  it("and points an administrator at the profile screen that can fix it", () => {
    // `/account/profile` carries the "Add me to the directory" button; a Team
    // Member cannot add themselves, so they are told whom to ask instead.
    // /account/profile is gated on org.settings.write; an HR manager holds
    // employee.create without it and is sent to the directory instead.
    expect(body).toMatch(/has\("org\.settings\.write"\)\s*\?\s*"\/account\/profile"/);
    expect(body).toMatch(/has\("employee\.create"\)\s*\?\s*"\/employees"/);
    expect(body).toMatch(/href=\{selfAddHref\}/);
    expect(body).toContain("Ask an administrator to add you to the employee directory.");
  });
});
