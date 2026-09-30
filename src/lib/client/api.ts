"use client";

import { toast } from "@/components/ui/toast";

/**
 * Client-side fetch helper.
 *
 * Maps the server's error envelope onto a readable message and shows the
 * correlation id when there is one, so a user reporting a problem can quote
 * something that ties back to a server log line.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  correlationId?: string;
}

export class RequestFailed extends Error {
  constructor(
    readonly error: ApiError,
    readonly status: number,
  ) {
    super(error.message);
    this.name = "RequestFailed";
  }
}

export async function api<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const { body, ...rest } = options;

  // FormData goes through untouched. Stringifying it yields "{}" with a JSON
  // content type, so the upload arrives empty and the server refuses it for a
  // reason that has nothing to do with the file -- and the browser has to set
  // the multipart boundary itself, which it only does when no Content-Type is
  // supplied. Every upload in the product used to hand-roll `fetch` to avoid
  // this; they no longer have to.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;

  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    ...(body !== undefined ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { error?: ApiError }
    | null;

  if (!response.ok) {
    const error: ApiError = payload?.error ?? {
      code: "INTERNAL",
      message: "Something went wrong. Please try again.",
    };
    /**
     * A dead session is not an error to toast.
     *
     * Every button and every poll used to answer a lapsed sign-in with "That
     * did not work -- Please sign in to continue", and nothing took the person
     * to the screen where they could. The one thing a 401 means is "sign in",
     * so that is where it goes -- a full navigation, so the layout guard runs
     * and the app comes back signed in rather than half-alive.
     */
    if (response.status === 401 && typeof window !== "undefined" && !isSignInPage()) {
      window.location.assign(signInHref());
    }
    throw new RequestFailed(error, response.status);
  }

  return payload as T;
}

export function isSignInPage(): boolean {
  const p = window.location.pathname;
  return p === "/login" || p.startsWith("/o/") || p === "/forgot-password" || p === "/signup";
}

/** The login screen, remembering where the person was. */
export function signInHref(): string {
  const here = window.location.pathname + window.location.search;
  return here && here !== "/" ? `/login?next=${encodeURIComponent(here)}` : "/login";
}

/** Runs a mutation with consistent toast feedback. Returns null on failure. */
export async function mutate<T>(
  fn: () => Promise<T>,
  messages: { success?: string; error?: string } = {},
): Promise<T | null> {
  try {
    const result = await fn();
    if (messages.success) toast.success(messages.success);
    return result;
  } catch (error) {
    if (error instanceof RequestFailed) {
      toast.error(messages.error ?? "That did not work", {
        description: error.error.correlationId
          ? `${error.error.message} (ref ${error.error.correlationId})`
          : error.error.message,
      });
    } else {
      toast.error("We could not reach the server", {
        description: "Check your connection and try again.",
      });
    }
    return null;
  }
}
