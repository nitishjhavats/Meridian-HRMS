import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The AI settings page is reachable with the AI module off, on purpose: the
 * saved key can be seen and the module switched back on. But `updateAiConfig`
 * refuses every write until the module is on, and the form let a key be typed
 * and "Save settings" pressed, then toasted the refusal. The page now tells
 * the form, and the form locks what would be refused; the connection test has
 * no module check and stays available.
 */

const PAGE = "src/app/(app)/settings/ai/page.tsx";
const FORM = "src/app/(app)/settings/ai/AiSettingsForm.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The opening tag of the button whose label follows. */
function buttonBefore(label: string): string {
  const body = code(FORM);
  const at = body.indexOf(label);
  expect(at, `no "${label}" button`).toBeGreaterThan(-1);
  return body.slice(body.lastIndexOf("<Button", at), at);
}

describe("with the AI module off", () => {
  it("the page tells the form", () => {
    const body = code(PAGE);
    expect(body).toMatch(/<AiSettingsForm initial=\{config\} moduleLive=\{moduleLive\} \/>/);
    expect(body).toMatch(/cannot be changed until it is on/);
  });

  it("saving and removing the key are locked", () => {
    const body = code(FORM);
    expect(body).toMatch(/const locked = !moduleLive/);
    expect(buttonBefore("Save settings")).toMatch(/disabled=\{locked\}/);
    expect(buttonBefore("Remove\n")).toMatch(/disabled=\{locked\}/);
  });

  it("so is the key field, which is otherwise typed into and lost", () => {
    const body = code(FORM);
    const at = body.indexOf('id="apiKey"');
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at, body.indexOf("/>", at))).toMatch(/disabled=\{locked\}/);
  });

  it("the connection test is not, because the service does not refuse it", () => {
    expect(buttonBefore("Test connection")).not.toMatch(/locked/);
  });

  it("and a page that says nothing gets a live form", () => {
    // Every other caller of the form is the module-on case.
    expect(code(FORM)).toMatch(/moduleLive = true/);
  });
});
