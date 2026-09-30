import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A like that is refused is said, not swallowed.
 *
 * The heart filled optimistically and, when the server said no, un-filled a
 * moment later with no word about why. In an organisation whose trial has
 * ended every like is refused, so every employee saw a button that looked
 * broken instead of a message that the subscription is read-only.
 */

const FEED = "src/app/(app)/announcements/Feed.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the like button", () => {
  const body = code(FEED);
  const toggle = body.slice(
    body.indexOf("async function toggleLike("),
    body.indexOf("async function loadComments("),
  );

  it("goes through mutate(), which toasts the server's reason", () => {
    expect(toggle).toMatch(/await mutate\(\s*\(\) => api\(`\/api\/announcements\/\$\{item\.id\}\/like`/);
    expect(toggle).toMatch(/error: "That like did not go through"/);
    expect(toggle).not.toMatch(/catch \{/);
  });

  it("still puts the heart back when it is refused", () => {
    expect(toggle).toMatch(/if \(ok === null\) setLikes\(\(l\) => \(\{ \.\.\.l, \[item\.id\]: current \}\)\)/);
  });
});
