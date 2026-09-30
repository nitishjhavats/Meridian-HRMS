"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Who is looking, for a client component whose page did not say.
 *
 * A server page already holds the viewer in its context and should hand the
 * component what it needs as a prop -- exact from the first paint, and free.
 * This is the fallback for a component rendered from a page that does not:
 * it asks `/api/auth/session` once after mount. Until the answer arrives the
 * result is `null`, and each caller decides what "not known yet" means for
 * its own controls -- a switch that would be refused stays off; a queue keeps
 * its buttons rather than hiding a whole column for a moment.
 *
 * Nothing here is trusted by the server, which re-checks every request. It
 * only decides what is offered, so that a button is not shown to somebody it
 * will always refuse.
 */
export interface Viewer {
  /** The employee record behind this login, if there is one. */
  employeeId: string | null;
  permissions: ReadonlySet<string>;
}

interface SessionPayload {
  authenticated: boolean;
  user?: { employeeId: string | null };
  permissions?: string[];
}

// Two queues on one page mount together and would ask twice. The request in
// flight is shared and forgotten once it settles, so a later visit asks afresh
// rather than reading an answer from before somebody's permissions changed.
let inFlight: Promise<Viewer> | null = null;

function fetchViewer(): Promise<Viewer> {
  if (!inFlight) {
    inFlight = api<SessionPayload>("/api/auth/session", { cache: "no-store" })
      .then((session) => ({
        employeeId: session.user?.employeeId ?? null,
        permissions: new Set(session.permissions ?? []),
      }))
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * `enabled` is false when the page supplied the answer as a prop, so the round
 * trip is skipped entirely.
 */
export function useViewer(enabled = true): Viewer | null {
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchViewer().then(
      (v) => {
        if (!cancelled) setViewer(v);
      },
      () => {
        // Could not ask. The viewer stays unknown and the caller's fallback
        // stands; a 401 has already been sent to the sign-in page by `api`.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return viewer;
}
