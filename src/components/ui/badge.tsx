import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        primary: "bg-primary-muted text-primary",
        // The `-text` tokens, not the solid fill: badge text is 12px on a tinted
        // surface, where the solid `success` fill measured 2.98:1 and warning was
        // 1.37:1 in dark mode.
        success: "bg-success-muted text-success-text",
        warning: "bg-warning-muted text-warning-text",
        danger: "bg-danger-muted text-danger-text",
        info: "bg-info-muted text-info-text",
        outline: "border border-border text-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
