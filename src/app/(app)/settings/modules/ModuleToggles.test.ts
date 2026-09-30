import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The modules page opens on `org.settings.read` and the switches write under
 * `org.modules.manage`. An HR manager holds the first and not the second, and
 * every switch they flipped answered with a 403 toast. The switches now wait
 * for that permission, and the reason is written above them.
 */

const TOGGLES = "src/app/(app)/settings/modules/ModuleToggles.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The one `<Switch` on the screen, opening tag only. */
function theSwitch(): string {
  const body = code(TOGGLES);
  const start = body.indexOf("<Switch");
  expect(start, "no switch").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("/>", start));
}

describe("module switches", () => {
  it("wait for org.modules.manage, not only for the row being toggleable", () => {
    expect(theSwitch()).toMatch(/disabled=\{!mayChange \|\| !row\.toggleable/);
  });

  it("stay off while nobody has said whether the viewer holds it", () => {
    // `canWrite ?? (viewer ? ... : null)`: undefined prop and no answer yet
    // is null, and `!null` disables. A switch that moves and is then refused
    // is worse than one that waits a moment.
    const body = code(TOGGLES);
    expect(body).toMatch(/canWrite\?: boolean/);
    expect(body).toMatch(/canWrite \?\? \(viewer \? viewer\.permissions\.has\("org\.modules\.manage"\) : null\)/);
  });

  it("and say why, once it is known they cannot", () => {
    const body = code(TOGGLES);
    expect(body).toMatch(/mayChange === false \?/);
    expect(body).toMatch(/You can see these modules but not change them/);
  });

  it("a page that says skips the round trip", () => {
    expect(code(TOGGLES)).toMatch(/useViewer\(canWrite === undefined\)/);
  });
});
