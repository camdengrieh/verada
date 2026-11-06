"use client";
// Adapted from 21st.dev @skyleen77/radix-checkbox (id 1766): the check draws itself in. The motion
// path animation is redone as a CSS stroke-dashoffset transition so it follows Radix state in both
// controlled and uncontrolled use (and stops under reduced motion); adds the indeterminate dash.
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

/**
 * 20px box with a 44px hit area. `tone="cause"` checks in sage (giving, voting); the default is
 * terracotta. Label it with a `<Label htmlFor>` or `FieldLabel`.
 */
export function Checkbox({
  className,
  tone = "primary",
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root> & { tone?: "primary" | "cause" }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group peer relative inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] border-[1.5px] border-ink-muted bg-paper-card text-primary-foreground outline-none transition-[background-color,border-color,box-shadow]",
        "after:absolute after:-inset-3 after:content-['']",
        "focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        tone === "primary"
          ? "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary"
          : "data-[state=checked]:border-sage data-[state=checked]:bg-sage data-[state=indeterminate]:border-sage data-[state=indeterminate]:bg-sage dark:text-paper",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator forceMount data-slot="checkbox-indicator" className="pointer-events-none flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3.5">
          <path
            d="M4.5 12.75l6 6 9-13.5"
            pathLength={1}
            className="[stroke-dasharray:1] [stroke-dashoffset:1] transition-[stroke-dashoffset] duration-200 ease-out group-data-[state=checked]:[stroke-dashoffset:0] group-data-[state=checked]:delay-75"
          />
          <path d="M6 12h12" className="hidden group-data-[state=indeterminate]:block" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
