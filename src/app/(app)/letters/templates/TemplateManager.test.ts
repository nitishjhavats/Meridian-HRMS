import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * How the template editor is wired to the two helpers in `framework.ts`.
 *
 * The helpers are unit-tested beside them; this pins that the screen actually
 * uses them -- that Save watches every editable field, and that the preview
 * is drawn from the editor rather than fetched already rendered.
 */

const MANAGER = "src/app/(app)/letters/templates/TemplateManager.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the template editor", () => {
  it("decides whether Save is enabled from every editable field", () => {
    const body = code(MANAGER);
    expect(body).toMatch(/const dirty = .*frameworkChanged\(draft, current\)/);
    // The old comparison, which watched the wording and nothing else.
    expect(body).not.toMatch(/draft\.footer !== current\.footer\)/);
  });

  it("renders the preview from the editor's text, not from a server-rendered copy", () => {
    const body = code(MANAGER);
    // The server is asked for values only; the text comes from the boxes.
    expect(body).toMatch(/api<\{ values: LetterValues \}>\(`\/api\/letters\/templates\/\$\{draft\.category\}\/preview`/);
    expect(body).toMatch(/renderFrameworkPreview\(draft, values\)/);
    // A keystroke used to blank the preview; now it re-renders it.
    expect(body).not.toMatch(/function set\([^)]*\)\s*\{[^}]*setPreview\(null\)/);
  });

  it("does not swallow a preview failure", () => {
    const body = code(MANAGER);
    const start = body.indexOf("async function runPreview");
    const end = body.indexOf("async function save");
    const runPreview = body.slice(start, end);
    expect(runPreview).not.toMatch(/\.catch\(\(\) => null\)/);
    expect(runPreview).toMatch(/error: "The preview could not be rendered"/);
  });
});
