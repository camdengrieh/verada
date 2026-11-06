"use client";
// Adapted from 21st.dev @ddoemonn/progress-bar (id 23549): spring-animated fill, indeterminate sweep,
// label row with a live percentage and a polite completion announcement. Built on Radix Progress for
// the progressbar role and values; tokens replace the stone/blue palette.
import { motion, useReducedMotion } from "motion/react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

export interface ProgressProps extends Omit<ComponentProps<typeof ProgressPrimitive.Root>, "value" | "children"> {
  /** Current value, or `null` while the amount of work is unknown. */
  value: number | null;
  max?: number;
  /** Visible label above the bar; also names the progressbar. Without it, pass `aria-label`. */
  label?: ReactNode;
  /** Shows the percentage (or `valueText`) on the label row. */
  showValue?: boolean;
  /** Replaces the percentage, e.g. "12.4 / 20 ETH". */
  valueText?: string;
  pendingLabel?: string;
  /** Announced once when the bar reaches max. */
  completeLabel?: string;
  tone?: "primary" | "cause" | "ink";
  size?: "sm" | "md";
}

const FILL = { type: "spring", stiffness: 210, damping: 34, mass: 0.9 } as const;

export function Progress({
  value,
  max = 100,
  label,
  showValue = Boolean(label),
  valueText,
  pendingLabel = "Working",
  completeLabel = "Complete",
  tone = "primary",
  size = "md",
  className,
  ...props
}: ProgressProps) {
  const reduced = useReducedMotion();
  const labelId = useId();
  const indeterminate = value === null;
  const fraction = indeterminate || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const percent = Math.round(fraction * 100);
  const complete = !indeterminate && fraction >= 1;
  const fill = tone === "primary" ? "bg-primary" : tone === "cause" ? "bg-sage" : "bg-ink";

  return (
    <div data-slot="progress-field" className={cn("flex w-full flex-col gap-2", className)}>
      {label || showValue ? (
        <div className="flex items-baseline justify-between gap-3 text-sm">
          {label ? (
            <span id={labelId} className="truncate font-semibold text-ink">
              {label}
            </span>
          ) : (
            <span />
          )}
          {showValue ? (
            <span aria-hidden="true" className="num shrink-0 text-ink-muted">
              {indeterminate ? pendingLabel : (valueText ?? `${percent}%`)}
            </span>
          ) : null}
        </div>
      ) : null}
      <ProgressPrimitive.Root
        data-slot="progress"
        value={indeterminate ? null : Math.min(max, Math.max(0, value))}
        max={max}
        aria-labelledby={label ? labelId : undefined}
        aria-valuetext={indeterminate ? pendingLabel : (valueText ?? `${percent}%`)}
        className={cn("relative w-full overflow-hidden rounded-full bg-sand", size === "md" ? "h-2.5" : "h-1.5")}
        {...props}
      >
        <ProgressPrimitive.Indicator asChild>
          <motion.span
            data-slot="progress-indicator"
            className={cn("absolute inset-0 block origin-left rounded-full", fill)}
            initial={false}
            animate={{ scaleX: fraction }}
            transition={reduced ? { duration: 0 } : FILL}
          />
        </ProgressPrimitive.Indicator>
        {indeterminate ? (
          reduced ? (
            <span aria-hidden="true" className={cn("absolute inset-0 block rounded-full opacity-40", fill)} />
          ) : (
            <motion.span
              aria-hidden="true"
              className={cn("absolute inset-y-0 left-0 block w-2/5 rounded-full", fill)}
              initial={{ x: "-100%" }}
              animate={{ x: "250%" }}
              transition={{ duration: 1.25, ease: "easeInOut", repeat: Infinity }}
            />
          )
        ) : null}
      </ProgressPrimitive.Root>
      <span aria-live="polite" className="sr-only">
        {complete ? completeLabel : ""}
      </span>
    </div>
  );
}
