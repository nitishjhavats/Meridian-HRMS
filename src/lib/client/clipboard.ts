"use client";

import { toast } from "@/components/ui/toast";

/**
 * Copy to the clipboard, and be honest about whether it worked.
 *
 * `navigator.clipboard.writeText` needs a secure context and a permission the
 * browser can refuse — an embedded frame, a hardened profile, the app reached
 * over plain http on a LAN address. Firing it and announcing success regardless
 * is worse than having no button at all: the places this is used are one-time
 * reveals, and somebody closes the only view of their recovery codes believing
 * they have them.
 *
 * Returns whether the text actually reached the clipboard, so a caller gating
 * something on "you have a copy of this" can trust the answer.
 */
export async function copyText(value: string, success = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(success);
    return true;
  } catch {
    toast.error("Your browser would not let us copy that", {
      description: "Select the text and copy it by hand.",
    });
    return false;
  }
}
