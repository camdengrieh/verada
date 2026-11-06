// Written for Varada (label layout follows shadcn/ui Separator, new-york)
"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

/**
 * Dividers for Direction A. `line` is the hairline, `dashed` the ledger rule used between list rows,
 * `brush` a short painted stroke (SVG displacement, no image), `ornament` a centred dot trio for
 * section breaks. Pass `label` for a labelled rule ("or", "Fees", "Epoch 12"). Decorative by
 * default (role="none"); set `decorative={false}` when it separates content for screen readers.
 */
export type DividerVariant = "line" | "dashed" | "brush" | "ornament";

export interface DividerProps extends Omit<ComponentProps<"div">, "children"> {
  variant?: DividerVariant;
  orientation?: "horizontal" | "vertical";
  label?: ReactNode;
  /** Colour token for the rule, e.g. "var(--ochre)". Defaults to the line token. */
  tone?: string;
  decorative?: boolean;
}

function Rule({ variant, tone, vertical }: { variant: DividerVariant; tone?: string; vertical: boolean }) {
  const id = `divider-${useId().replace(/:/g, "")}`;
  if (variant === "brush" && !vertical) {
    return (
      <svg aria-hidden="true" viewBox="0 0 300 12" preserveAspectRatio="none" className="h-3 w-full min-w-6 flex-1">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves={2} seed={4} />
          <feDisplacementMap in="SourceGraphic" scale={4} />
        </filter>
        <path d="M2 7 C 70 3, 150 10, 298 5" stroke={tone ?? "var(--ochre)"} strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round" fill="none" filter={`url(#${id})`} />
      </svg>
    );
  }
  if (variant === "ornament" && !vertical) {
    return (
      <span aria-hidden="true" className="flex flex-1 items-center gap-2">
        <span className="h-px flex-1 bg-line" style={tone ? { background: tone } : undefined} />
        <span className="flex gap-1.5">
          <span className="size-1 rounded-full bg-ochre" />
          <span className="size-1.5 rounded-full bg-terracotta" />
          <span className="size-1 rounded-full bg-sage" />
        </span>
        <span className="h-px flex-1 bg-line" style={tone ? { background: tone } : undefined} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        vertical ? "w-px self-stretch" : "h-px flex-1",
        variant === "dashed" ? (vertical ? "border-l border-dashed" : "border-t border-dashed") : "bg-line",
        variant === "dashed" && "border-line-strong bg-transparent",
      )}
      style={tone ? (variant === "dashed" ? { borderColor: tone } : { background: tone }) : undefined}
    />
  );
}

export function Divider({ variant = "line", orientation = "horizontal", label, tone, decorative = true, className, ...props }: DividerProps) {
  const vertical = orientation === "vertical";
  const a11y = decorative ? { role: "none" as const } : { role: "separator" as const, "aria-orientation": orientation };
  return (
    <div
      data-slot="divider"
      data-variant={variant}
      {...a11y}
      className={cn(vertical ? "flex self-stretch" : "flex w-full items-center gap-3", className)}
      {...props}
    >
      <Rule variant={variant} tone={tone} vertical={vertical} />
      {label && !vertical ? (
        <>
          <span className="kicker shrink-0">{label}</span>
          <Rule variant={variant === "ornament" ? "line" : variant} tone={tone} vertical={false} />
        </>
      ) : null}
    </div>
  );
}
