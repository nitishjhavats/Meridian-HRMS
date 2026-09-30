import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * One composition, one draft.
 *
 * "Preview the PDF" created a new letter every time it was pressed, and "Save
 * & issue" created yet another -- so a letter previewed twice before issue
 * left two numbered drafts behind, each to be binned by hand. And "Save &
 * issue" pressed straight from a template asked the server to issue a body
 * with unresolved placeholders: the number was consumed, the issue refused,
 * the editor closed, and the draft sat in the list with nothing but a bin
 * beside it.
 */

const COMPOSER = "src/app/(app)/letters/LetterComposer.tsx";
const LIST = "src/app/(app)/letters/LetterList.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The source of one function, up to the marker that follows it. */
function fn(body: string, name: string, next: string): string {
  const start = body.indexOf(`function ${name}(`);
  expect(start, `no ${name}`).toBeGreaterThan(-1);
  const end = body.indexOf(next, start + 1);
  expect(end, `no ${next}`).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** `save` is the last function before the render; nothing but the empty-list check follows it. */
const AFTER_SAVE = "employees.length === 0";

describe("the letter composer keeps to one draft", () => {
  const body = code(COMPOSER);

  it("creates the row in exactly one place", () => {
    // Every POST /api/letters -- the create -- lives in `persist`.
    const creates = body.match(/api<[^>]*>\("\/api\/letters",/g) ?? [];
    expect(creates).toHaveLength(1);
    expect(fn(body, "persist", "function previewPdf(")).toMatch(/api<[^>]*>\("\/api\/letters",/);
  });

  it("writes to the draft it already has instead of making another", () => {
    const persist = fn(body, "persist", "function previewPdf(");
    expect(persist).toMatch(/if \(bound\)/);
    expect(persist).toMatch(/action: "save"/);
    expect(persist).toMatch(/setBound\(next\)/);
  });

  it("previews and issues through that same draft", () => {
    const preview = fn(body, "previewPdf", "function finish(");
    expect(preview).toMatch(/await persist\(/);
    expect(preview).not.toMatch(/"\/api\/letters",/);
    const save = fn(body, "save", AFTER_SAVE);
    expect(save).toMatch(/await persist\(/);
    expect(save).toMatch(/api\(`\/api\/letters\/\$\{letter\.id\}`/);
    expect(save).toMatch(/action: "issue"/);
  });
});

describe("Save & issue", () => {
  const body = code(COMPOSER);
  const save = fn(body, "save", AFTER_SAVE);

  it("checks the preview before it touches the server", () => {
    const check = save.indexOf("await fetchPreview()");
    const write = save.indexOf("await persist(");
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
    expect(save.slice(check, write)).toMatch(/if \(!latest\.canIssue\)/);
  });

  it("stays open when the issue is refused, bound to the numbered draft", () => {
    const after = save.slice(save.indexOf("if (issued === null)"));
    // Closing was the dead end: the draft was in the list with no way back.
    expect(after.slice(0, after.indexOf("}"))).not.toMatch(/setOpen\(false\)|finish\(\)/);
  });
});

describe("Preview the PDF", () => {
  it("opens the tab while it is still the click", () => {
    const preview = fn(code(COMPOSER), "previewPdf", "function finish(");
    const opened = preview.indexOf('window.open("", "_blank")');
    const awaited = preview.indexOf("await ");
    expect(opened).toBeGreaterThan(-1);
    expect(awaited).toBeGreaterThan(opened);
    expect(preview).toMatch(/tab\.location\.href = url/);
    expect(preview).toMatch(/tab\?\.close\(\)/);
  });
});

describe("a draft in the list can be brought back into the editor", () => {
  const body = code(COMPOSER);

  it("from an Edit link on the draft's row, and only there", () => {
    const list = code(LIST);
    const drafts = list.slice(
      list.indexOf('canManage && l.status === "DRAFT"'),
      list.indexOf('canManage && l.status === "ISSUED"'),
    );
    expect(drafts).toMatch(/<Link href=\{`\/letters\?draft=\$\{l\.id\}`\}>/);
    expect(list.match(/\?draft=/g)).toHaveLength(1);
  });

  it("by its id in the address, which is watched: the link lands on the page the editor is already on", () => {
    // A one-time read on mount saw nothing, because a same-page link changes
    // the address without remounting the component.
    expect(body).not.toMatch(/window\.location\.search\)\.get\("draft"\)/);
    expect(body).toMatch(/const draftId = useSearchParams\(\)\.get\("draft"\);/);
    const effect = body.slice(body.indexOf("useEffect("), body.indexOf("async function useTemplate"));
    expect(effect).toMatch(/\}, \[draftId\]\);/);
    expect(effect).toMatch(/api<\{ letter: StoredLetter \}>\(`\/api\/letters\/\$\{id\}`\)/);
    expect(effect).toMatch(/letter\.status !== "DRAFT"/);
    expect(effect).toMatch(/reopened: true/);
  });

  it("with the fill-in form up, which is the reason for reopening", () => {
    const effect = body.slice(body.indexOf("useEffect("), body.indexOf("async function useTemplate"));
    expect(effect).toMatch(/await fetchPreview\(\{/);
  });

  it("and its person and type fixed, since the number was cut for them", () => {
    expect(body).toMatch(/id="letterEmployee"[\s\S]{0,80}disabled=\{reopened\}/);
    expect(body).toMatch(/id="letterCategory"[\s\S]{0,80}disabled=\{reopened\}/);
  });

  it("and, once done with, does not leave the next letter addressed to somebody off the list", () => {
    // A reopened draft can be for a person no longer active; the select shows
    // them through `extraEmployee`, which `finish` drops. The id has to go
    // with it, or the next letter is numbered for somebody the screen never
    // showed.
    const finish = fn(body, "finish", "async function save(");
    expect(finish).toMatch(/setExtraEmployee\(null\)/);
    expect(finish).toMatch(
      /employeeId: employees\.some\(\(e\) => e\.id === f\.employeeId\)\s*\? f\.employeeId\s*: \(employees\[0\]\?\.id \?\? ""\)/,
    );
  });
});

describe("with nobody to write to", () => {
  it("says so, and where to go, instead of showing an empty form", () => {
    const body = code(COMPOSER);
    const alert = body.slice(body.indexOf("employees.length === 0"), body.indexOf("if (!open)"));
    expect(alert).toMatch(/title="Add an employee first"/);
    expect(alert).toMatch(/href="\/employees"/);
  });
});
