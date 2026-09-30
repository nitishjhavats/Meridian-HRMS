"use client";

import { Toaster as Sonner, toast as sonnerToast } from "sonner";

/** App-wide toast host. Mounted once in the root layout. */
export function Toaster() {
  return (
    <Sonner
      position="top-center"
      toastOptions={{
        classNames: {
          toast:
            "!bg-card !text-card-foreground !border !border-border !rounded-lg !shadow-lg",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
        },
      }}
      // Four seconds for anything that went right.
      duration={SUCCESS_MS}
    />
  );
}

const SUCCESS_MS = 4_000;

/**
 * Errors stay much longer, because they ask something of the reader.
 *
 * The comment here used to claim errors stayed "long enough to read a
 * correlation id off them" while setting one duration for everything — and four
 * seconds is not long enough to read a ten-character id, let alone write it
 * down or repeat it to somebody. Sonner's duration is per-toast, so the wrapper
 * below is where an error gets its own.
 */
const ERROR_MS = 12_000;

/**
 * The app's `toast`, with the error duration already applied.
 *
 * Same shape as sonner's, so every existing call site keeps working; an
 * explicit `duration` in the options still wins.
 */
export const toast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  {
    error: (
      message: Parameters<typeof sonnerToast.error>[0],
      options?: Parameters<typeof sonnerToast.error>[1],
    ) => sonnerToast.error(message, { duration: ERROR_MS, ...options }),
  },
);
