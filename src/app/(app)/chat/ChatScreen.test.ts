import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The owner of a new organisation has a login and no employee record.
 * `/api/chat` answers that with a 422 -- and the screen used to swallow it,
 * show "Loading…" in the contact list for ever, and ask again every twenty
 * seconds for as long as the tab stayed open. The 422 is now a sentence on
 * the screen, and a poll that has been answered stops asking.
 */

const SCREEN = "src/app/(app)/chat/ChatScreen.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The effect that sets an interval on `period`, from `useEffect(` to its dependency list. */
function effectUsing(body: string, period: string): string {
  const at = body.indexOf(`}, ${period});`);
  expect(at, `no interval on ${period}`).toBeGreaterThan(-1);
  const start = body.lastIndexOf("useEffect(", at);
  expect(start, `no effect around ${period}`).toBeGreaterThan(-1);
  const end = body.indexOf("]);", at);
  return body.slice(start, end);
}

describe("the chat polls", () => {
  const body = code(SCREEN);

  it("tell a refusal from a hiccup by the status", () => {
    expect(body).toMatch(/function isAnswer\(error: unknown\): boolean/);
    expect(body).toMatch(/error instanceof RequestFailed && error\.status >= 400 && error\.status < 500/);
  });

  it("each loader says whether to go on asking, and keeps the error", () => {
    expect(body).toMatch(/const loadContacts = useCallback\(async \(\): Promise<boolean>/);
    expect(body).toMatch(/setListError\(error\);\n\s*return !isAnswer\(error\);/);
    expect(body).toMatch(/const loadConversation = useCallback\(async \(employeeId: string\): Promise<boolean>/);
    expect(body).toMatch(/setThreadError\(error\);\n\s*return !isAnswer\(error\);/);
  });

  it("the list poll clears its own interval on a refusal", () => {
    const effect = effectUsing(body, "LIST_POLL_MS");
    expect(effect).toMatch(/clearInterval\(timer\)/);
    expect(effect).toMatch(/if \(!keep\) halt\(\)/);
    expect(effect).toMatch(/return halt;/);
  });

  it("so does the thread poll", () => {
    const effect = effectUsing(body, "THREAD_POLL_MS");
    expect(effect).toMatch(/if \(!keep\) halt\(\)/);
    expect(effect).toMatch(/return halt;/);
  });

  it("a Retry bumps the attempt, which is what restarts the effect", () => {
    expect(body).toMatch(/\[listAttempt, loadContacts\]/);
    expect(body).toMatch(/\[openWith, threadAttempt, loadConversation\]/);
    expect(body).toMatch(/setListAttempt\(\(n\) => n \+ 1\)/);
    expect(body).toMatch(/setThreadAttempt\(\(n\) => n \+ 1\)/);
  });
});

describe("what the screen says", () => {
  const body = code(SCREEN);

  it("the list shows the failure in place of the spinner, and over a stale list when refused", () => {
    expect(body).toMatch(/listError !== null && \(contacts === null \|\| isAnswer\(listError\)\)/);
    expect(body).toMatch(/<LoadFailed[\s\S]*?error=\{listError\}[\s\S]*?onRetry=\{retryContacts\}/);
    // The sentence comes before the spinner in the ternary, so a refusal is
    // never rendered as "Loading…".
    expect(body.indexOf("error={listError}")).toBeLessThan(body.indexOf("<Spinner /> Loading"));
  });

  it("a conversation that could not be opened gets its own pane with the way back", () => {
    expect(body).toMatch(/openWith && threadError !== null \?/);
    expect(body).toMatch(/<LoadFailed error=\{threadError\} what="This conversation" onRetry=\{retryConversation\}/);
  });

  it("an open thread whose poll was refused says so above the messages", () => {
    expect(body).toMatch(/threadError !== null && isAnswer\(threadError\) \?/);
  });
});
