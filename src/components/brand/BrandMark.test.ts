import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The maker's credit has now been reported three times, three different ways.
 *
 * 1. It was `truncate`, so at a narrow width it read "HRMS by Broadma..." — a
 *    credit that is only half there is worse than none.
 * 2. Truncation was removed and it was allowed to wrap, which fixed the
 *    clipping and produced "HRMS by / Broadmate / Global" on a 375px phone:
 *    three lines under a one-line name.
 * 3. Now it is one line, and the room comes from the header's own gaps and the
 *    width of its icons.
 *
 * Each fix broke the one before it, which is what a test file is for. These
 * pin the property rather than the pixels: never cut, never three lines, and
 * the space it needs is taken from things that had it to spare.
 */

const MARK = "src/components/brand/BrandMark.tsx";
const SHELL = "src/components/layout/AppShell.tsx";
const HOME = "src/app/page.tsx";
const CSS = "src/app/globals.css";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The JSX for the second line, credit and all. */
function creditLine(): string {
  const body = code(MARK);
  const start = body.indexOf("{subtitle ??");
  expect(start, "no credit line").toBeGreaterThan(-1);
  // The className sits on the span immediately above it.
  return body.slice(body.lastIndexOf("<span", start), start);
}

describe("the maker's credit", () => {
  it("is never truncated", () => {
    // Report one. It is a fixed twenty-four characters; nothing about it needs
    // to be shortened, and shortening it produced "HRMS by Broadma...".
    expect(creditLine()).not.toMatch(/\btruncate\b/);
  });

  it("is one line by default", () => {
    // Report two. Without this it wrapped to three lines on a 375px phone.
    expect(creditLine()).toMatch(/\bwhitespace-nowrap\b/);
  });

  it("and wraps rather than clips on a screen too narrow to hold it", () => {
    /**
     * Measured against this app's own stylesheet: the text column gets 118px at
     * a 320px viewport and the line needs 123px at 10px. Below 360 there is
     * genuinely not room, and two whole lines beat one cut one. Every phone
     * this product will meet today is 360 or wider.
     */
    expect(creditLine()).toMatch(/max-\[359px\]:whitespace-normal/);
  });

  it("is smaller on a phone than on a desktop, deliberately", () => {
    // 136px at 11px, 123px at 10px. The thirteen pixels are the difference
    // between fitting a 360px screen and not.
    expect(creditLine()).toMatch(/text-\[10px\]/);
    expect(creditLine()).toMatch(/sm:text-\[11px\]/);
  });
});

describe("the organisation's name above it", () => {
  it("still truncates, because that one is unbounded", () => {
    // Something has to give when a name is longer than the screen, and it is
    // this rather than the credit: this one is arbitrary length and can carry
    // an ellipsis without becoming a lie.
    const body = code(MARK);
    const start = body.indexOf("{title}");
    const line = body.slice(body.lastIndexOf("<span", start), start);
    expect(line).toMatch(/\btruncate\b/);
  });

  it("is bigger than it was in the app bar", () => {
    // "organisation ka naam bada font me". `text-sm` at 14px read as a
    // breadcrumb above a 11px credit; 16px reads as a heading.
    expect(code(MARK)).toMatch(/size === "sm" \? "text-base"/);
  });
});

describe("where the room came from", () => {
  it("the header bar's icons are narrower, and only there", () => {
    // Full 44px of height kept; the horizontal padding is what was spent.
    const css = source(CSS);
    const start = css.indexOf(".touch-target-narrow");
    expect(start, "no narrow target").toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toMatch(/min-height: 44px/);
    expect(block).toMatch(/min-width: 36px/);
  });

  it("and the bar uses it for every icon it carries", () => {
    // One at 44 undoes the others: the row is a sum.
    const body = code(SHELL);
    const header = body.slice(body.indexOf("<header"), body.indexOf("</header>"));
    expect(header).not.toMatch(/className="touch-target /);
    expect((header.match(/touch-target-narrow/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("with tighter gaps on a phone and the old ones from sm up", () => {
    const body = code(SHELL);
    const header = body.slice(body.indexOf("<header"), body.indexOf(">", body.indexOf("<header")));
    expect(header).toMatch(/gap-1\b/);
    expect(header).toMatch(/px-2\b/);
    expect(header).toMatch(/sm:px-4/);
  });
});

describe("the front door says its own name once", () => {
  it("uses the loud size", () => {
    // The product's own page had the same 18px title as a settings screen.
    expect(code(HOME)).toMatch(/size="lg"/);
  });

  it("and the credit alone, not the product name twice", () => {
    // The default second line is "HRMS by Broadmate Global", which is right
    // above an organisation's name and says HRMS twice under HRMS.
    expect(code(HOME)).toMatch(/subtitle=\{branding\.maker\.credit\}/);
  });

  it("shortening the sign-up wording rather than dropping the door", () => {
    // "Create an organisation" is 150px of a 375px row. The words shorten; the
    // button stays, because a vanished button reads as "there is no way in".
    expect(code(HOME)).toMatch(/Sign up/);
    expect(code(HOME)).toMatch(/Create an organisation/);
  });
});
