"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-sm font-medium leading-none text-foreground", className)}
    {...props}
  >
    {children}
    {required ? (
      <span className="ml-0.5 text-danger-text" aria-hidden>
        *
      </span>
    ) : null}
  </LabelPrimitive.Root>
));
Label.displayName = "Label";

export function FieldError({ id, children }: { id?: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-xs text-danger-text" role="alert">
      {children}
    </p>
  );
}

export function FieldHint({ id, children }: { id?: string; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A label, a control, and the two bits of text that explain it.
 *
 * The error and the hint are **linked to the control**, which they were not.
 * Before this, the error was a sibling `<p role="alert">`: announced once when
 * it appeared and then permanently undiscoverable, so somebody tabbing back to
 * a rejected field heard "Password, edit text, required" and nothing about what
 * was wrong. The hint was never announced at all, which lost real content —
 * "This becomes your sign-in and the Owner account" is not decoration.
 *
 * `aria-describedby` appeared **zero times** in the codebase before this, and
 * `Input` has been shipping `aria-[invalid=true]:border-danger` since it was
 * written — a red-border affordance that nothing could ever trigger, because
 * the component that owns errors never set the attribute.
 *
 * Cloning the child rather than asking every call site to wire it up: there are
 * around two hundred of them, they all already pass `htmlFor`, and a rule that
 * depends on two hundred people remembering is not a rule. A child that sets
 * its own `aria-describedby` keeps it — `cloneElement`'s props win only where
 * the child left the slot empty.
 */
export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined;
  const hintId = htmlFor && hint && !error ? `${htmlFor}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const control =
    React.isValidElement(children) && (describedBy || error)
      ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
          "aria-invalid": error ? true : (children.props as Record<string, unknown>)["aria-invalid"],
          "aria-describedby":
            (children.props as Record<string, unknown>)["aria-describedby"] ?? describedBy,
        })
      : children;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {control}
      <FieldError id={errorId}>{error}</FieldError>
      {!error ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}
