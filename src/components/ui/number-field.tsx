"use client";

import * as React from "react";
import { Input } from "./input";
import { isPartialNumber, normaliseNumber } from "@/domain/ui/numberField";

/**
 * A number input you can actually empty.
 *
 * Reported, and reproducible on roughly forty fields across fifteen screens:
 * backspacing to clear a box leaves one digit behind that will not delete, so
 * the only way to type a value is to type it around the leftover and remove
 * that afterwards.
 *
 * The cause is one line, repeated:
 *
 *     value={count}
 *     onChange={(e) => setCount(Number(e.target.value))}
 *
 * Deleting the last character makes `e.target.value` the empty string;
 * `Number("")` is `0`; React re-renders with `0` in the box. Several sites make
 * it worse with `Number(...) || 1` or a clamp, so the stuck value is a 1, or a
 * 2048, or the current year — a number the person never typed and cannot
 * remove.
 *
 * The fix is that **the input holds a string and the caller holds a number**.
 * While somebody is typing, "" and "1." and "0" are all legitimate states of a
 * text box and none of them is a number yet. `onValueChange` reports `null` for
 * empty, so a caller can tell "cleared" from "zero" — which is a distinction
 * several of these fields genuinely need.
 *
 * The pattern already existed twice in this codebase, in
 * `DesignationAllocations` and `SalaryStructure`, both of which keep a string
 * draft and parse on blur. This is that, made reusable, so the next numeric
 * field is right without anybody having to remember why.
 */

export interface NumberFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  /** The committed value. `null` renders an empty box. */
  value: number | null;
  /** Fires on every keystroke. `null` means the box is empty. */
  onValueChange: (value: number | null) => void;
  /**
   * Clamped on blur, never while typing.
   *
   * Clamping on each keystroke is the other half of this bug: with `min={1}`,
   * typing "10" goes "1" → clamp → "1", and the "0" is eaten. Ranges are a
   * property of the committed value, so they are applied when the box is left.
   */
  min?: number;
  max?: number;
  /** Decimal places to accept. 0 means whole numbers only. */
  decimals?: number;
}

export const NumberField = React.forwardRef<HTMLInputElement, NumberFieldProps>(
  ({ value, onValueChange, min, max, decimals = 0, onBlur, ...props }, ref) => {
    /**
     * The text in the box, when it differs from the committed number.
     *
     * `null` means "show the value" — so a change from elsewhere (a form reset,
     * a fetch) reaches the box, which it would not if the draft always won.
     */
    const [draft, setDraft] = React.useState<string | null>(null);

    const shown = draft ?? (value === null ? "" : String(value));

    return (
      <Input
        ref={ref}
        // `inputMode` rather than `type="number"`: it brings up the numeric
        // keypad on a phone without the spinner, the scroll-wheel-changes-the-
        // value behaviour, or the browser's own opinion about what is valid.
        type="text"
        inputMode={decimals > 0 ? "decimal" : "numeric"}
        value={shown}
        onChange={(e) => {
          const raw = e.target.value.trim();
          // A character that cannot be part of a number is simply not accepted,
          // which is what the old `type="number"` was doing for us.
          if (!isPartialNumber(raw, decimals)) return;
          setDraft(raw);
          onValueChange(raw === "" ? null : Number(raw));
        }}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            // Left empty. The caller already has `null` and decides what that
            // means — several of these fields treat it as "unset", which is not
            // the same as zero.
            setDraft(null);
            onBlur?.(e);
            return;
          }
          // The same rule the tests pin, rather than a second copy of it here.
          const next = normaliseNumber(raw, { min, max, decimals, fallback: value });
          setDraft(null);
          if (next !== value) onValueChange(next);
          onBlur?.(e);
        }}
        {...props}
      />
    );
  },
);
NumberField.displayName = "NumberField";
