import { describe, expect, it } from "vitest";

import { RequestFailed } from "./api";
import { describeLoadFailure } from "./loadFailure";

/**
 * What a failed load says, and whether a retry is offered.
 *
 * `describeLoadFailure` recognises a `RequestFailed` by its shape rather than
 * by importing the class -- see the note at the top of the module -- so these
 * run against the real class to pin that the shape still matches.
 */

function failed(status: number, message: string, correlationId?: string): RequestFailed {
  return new RequestFailed(
    { code: "INTERNAL", message, ...(correlationId ? { correlationId } : {}) },
    status,
  );
}

describe("a request the server answered", () => {
  it("carries the server's own sentence and the reference, and a 5xx can be retried", () => {
    const out = describeLoadFailure(failed(500, "The policy could not be read.", "abc123"), "The salary structure");
    expect(out).toEqual({
      title: "The salary structure could not be loaded",
      description: "The policy could not be read.",
      correlationId: "abc123",
      refused: false,
    });
  });

  it("a 403 is 'not available to you' -- a read, not a change -- and offers no retry", () => {
    const out = describeLoadFailure(failed(403, "You do not have permission to do that."));
    expect(out.title).toBe("Not available to you");
    expect(out.description).toBe("You do not have permission to do that.");
    expect(out.refused).toBe(true);
    expect(out.correlationId).toBeUndefined();
  });

  it("a 402 is read-only, in the server's words", () => {
    const out = describeLoadFailure(
      failed(402, "Your trial has ended. Add seats to continue making changes."),
    );
    expect(out.title).toBe("Read-only for now");
    expect(out.description).toMatch(/trial has ended/);
    expect(out.refused).toBe(true);
  });

  it("a 401 says signed out, whatever the envelope said", () => {
    const out = describeLoadFailure(failed(401, "Please sign in to continue."));
    expect(out.title).toBe("Signed out");
    expect(out.refused).toBe(true);
  });

  it("a 422 is an answer -- the same question gets the same reply", () => {
    const out = describeLoadFailure(
      failed(422, "Chat is between employees, and your login is not linked to one."),
      "The people list",
    );
    expect(out.title).toBe("The people list could not be loaded");
    expect(out.description).toMatch(/not linked to one/);
    expect(out.refused).toBe(true);
  });

  it("a 404 is an answer too", () => {
    expect(describeLoadFailure(failed(404, "That employee could not be found.")).refused).toBe(true);
  });

  it("a rate limit and a timeout mean later, not never", () => {
    expect(describeLoadFailure(failed(429, "Too many attempts.")).refused).toBe(false);
    expect(describeLoadFailure(failed(408, "Timed out.")).refused).toBe(false);
  });

  it("falls back to the Error message when the envelope carried none", () => {
    const bare = new RequestFailed({ code: "INTERNAL", message: "" }, 500);
    expect(describeLoadFailure(bare).description).toBe("Something went wrong. Please try again.");
  });
});

describe("a request that never got an answer", () => {
  it("a TypeError from fetch is 'could not reach the server', retryable", () => {
    const out = describeLoadFailure(new TypeError("Failed to fetch"));
    expect(out).toEqual({
      title: "We could not reach the server",
      description: "Check your connection and try again.",
      refused: false,
    });
  });

  it("something that is not an error at all reads the same", () => {
    expect(describeLoadFailure("boom").title).toBe("We could not reach the server");
    expect(describeLoadFailure(null).refused).toBe(false);
  });

  it("an Error merely named RequestFailed without a status is not trusted", () => {
    const impostor = Object.assign(new Error("x"), { name: "RequestFailed" });
    expect(describeLoadFailure(impostor).title).toBe("We could not reach the server");
  });
});

describe("the default subject", () => {
  it("reads as a sentence when nobody named the thing", () => {
    expect(describeLoadFailure(failed(500, "x")).title).toBe("This could not be loaded");
  });
});
