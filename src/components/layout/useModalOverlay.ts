"use client";

import { useEffect, useRef } from "react";

/**
 * The three things a hand-rolled overlay always forgets.
 *
 * The mobile navigation drawer and the "More" sheet are `position: fixed`
 * overlays that had no dialog semantics at all: opening one left focus behind
 * it, so the first Tab went into the still-live page underneath; Escape did
 * nothing; and closing lost focus to `<body>` rather than returning it to the
 * button that opened it. A screen reader read straight through the overlay into
 * the page behind, because nothing was marked inert.
 *
 * The obvious fix is to make them Radix dialogs — `@radix-ui/react-dialog` is
 * already a dependency and `ui/dialog.tsx` already renders as a bottom sheet on
 * mobile. That is the right long-term shape, but it means rewriting the
 * drawer's markup and its animation, so this hook does the same three jobs
 * against the existing DOM: trap the focus, honour Escape, and put focus back.
 *
 * Pair it with `role="dialog" aria-modal="true"` and a label on the container.
 */
export function useModalOverlay(
  open: boolean,
  onClose: () => void,
): React.RefObject<HTMLDivElement | null> {
  const container = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Remember what to give focus back to, before moving it.
    restoreTo.current = document.activeElement as HTMLElement | null;

    const node = container.current;
    const focusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // Into the panel, not onto the scrim: the first thing a keyboard user meets
    // should be the content they opened, not the button that closes it.
    const first = focusable();
    (first[1] ?? first[0])?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped.
      if (event.shiftKey && (active === firstItem || !node?.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    // The page behind must not scroll under the overlay, and on iOS it does.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Only if focus is still inside what is being removed — otherwise this
      // would yank it away from wherever the user has since moved.
      if (!node || node.contains(document.activeElement)) {
        restoreTo.current?.focus?.();
      }
    };
  }, [open, onClose]);

  return container;
}
