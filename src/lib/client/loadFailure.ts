/**
 * What to say when a fetch does not come back.
 *
 * Every mount-time `api()` call in the product used to end in
 * `.catch(() => null)`, which left its "Loading…" on the screen for ever: an
 * expired session, a dropped connection, a refused permission and a 500 all
 * looked exactly alike, and the person could not tell whether to wait, to try
 * again, or to ask somebody. This turns the failure into a title, a sentence
 * and one decision -- whether a retry could possibly change the answer.
 *
 * Kept free of imports on purpose. `components/ui/states.tsx` renders this and
 * is itself imported by server components, so pulling the `"use client"` api
 * module in here would drag a client boundary into every page guard. A
 * `RequestFailed` is recognised by its shape instead; the test beside this file
 * pins that shape against the real class.
 */

export interface LoadFailure {
  title: string;
  description: string;
  correlationId?: string;
  /**
   * The server answered on purpose -- signed out, read-only, not permitted,
   * not found, or the request itself was wrong. Asking the same question again
   * gets the same answer, so no Retry is offered for these.
   */
  refused: boolean;
}

interface RequestFailure {
  status: number;
  message: string;
  correlationId?: string;
}

function asRequestFailure(error: unknown): RequestFailure | null {
  if (!(error instanceof Error) || error.name !== "RequestFailed") return null;
  const failed = error as Error & {
    status?: unknown;
    error?: { message?: unknown; correlationId?: unknown };
  };
  if (typeof failed.status !== "number") return null;
  const message =
    typeof failed.error?.message === "string" && failed.error.message
      ? failed.error.message
      : error.message || "Something went wrong. Please try again.";
  const correlationId =
    typeof failed.error?.correlationId === "string" ? failed.error.correlationId : undefined;
  return { status: failed.status, message, ...(correlationId ? { correlationId } : {}) };
}

/** A 4xx is an answer; the two that mean "later" are the exceptions. */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function describeLoadFailure(error: unknown, what = "This"): LoadFailure {
  const failed = asRequestFailure(error);

  if (!failed) {
    return {
      title: "We could not reach the server",
      description: "Check your connection and try again.",
      refused: false,
    };
  }

  const reference = failed.correlationId ? { correlationId: failed.correlationId } : {};

  if (failed.status === 401) {
    return {
      title: "Signed out",
      description: "Your session has ended. Sign in again to continue.",
      refused: true,
    };
  }
  if (failed.status === 402) {
    return { title: "Read-only for now", description: failed.message, ...reference, refused: true };
  }
  // A load is a read. "Not yours to change" was the title here, over lists
  // the person was only ever looking at.
  if (failed.status === 403) {
    return { title: "Not available to you", description: failed.message, ...reference, refused: true };
  }

  return {
    title: `${what} could not be loaded`,
    description: failed.message,
    ...reference,
    refused: isRefusal(failed.status),
  };
}
