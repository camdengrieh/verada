// Adapted from 21st.dev @kevingirelli/marquee (id 35200), using the library's animate-marquee utility
"use client";

import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@varada/ui/lib/utils";

export type ActivityKind = "BUY" | "SELL" | "GIVE" | "VOTE" | "NEW";

export interface ActivityTickerItem {
  id: string;
  kind: ActivityKind;
  /** "$HARAMBE" */
  symbol: string;
  /** "$1,240 via NVDAon" */
  text: string;
}

export const ACTIVITY_TAG: Record<ActivityKind, string> = {
  BUY: "bg-sage-tint text-sage-ink",
  SELL: "bg-terracotta-tint text-terracotta-strong",
  GIVE: "bg-ochre-tint text-ochre-ink",
  NEW: "bg-stock-tint text-stock-ink",
  VOTE: "bg-etf-tint text-etf-ink",
};

export interface ActivityTickerProps extends Omit<ComponentProps<"section">, "children"> {
  items: readonly ActivityTickerItem[];
  /** Seconds per loop. */
  duration?: number;
  /** Space between items (any CSS length). */
  gap?: string;
  label?: string;
  /** Hold the loop still (e.g. while a dialog opened from it is up). */
  paused?: boolean;
  /** Which way the strip runs; pair a left and a right strip for a two-way ticker. */
  direction?: "left" | "right";
  /** The badge at the start of the strip. */
  tag?: string;
}

/**
 * The live strip under the header. One CSS transform animation (`animate-marquee`) over two copies
 * of the items; the copy is hidden from assistive tech and can't take focus. It pauses on hover and
 * keyboard focus, and with prefers-reduced-motion it stops and scrolls by hand instead.
 */
export function ActivityTicker({ items, duration = 40, gap = "1.75rem", label = "Live activity", paused, direction = "left", tag = "Live", className, style, ...props }: ActivityTickerProps) {
  const group = (copy: number) => (
    <ul
      key={copy}
      aria-hidden={copy > 0 ? true : undefined}
      inert={copy > 0 ? true : undefined}
      className={cn("m-0 flex shrink-0 list-none items-center gap-(--marquee-gap) p-0", copy > 0 && "motion-reduce:hidden")}
    >
      {items.map((t) => (
        <li key={t.id} className="inline-flex items-center gap-2 whitespace-nowrap text-sm">
          <span className={cn("rounded-md px-2 py-0.5 text-[11px] font-bold", ACTIVITY_TAG[t.kind])}>{t.kind}</span>
          <strong>{t.symbol}</strong>
          <span className="text-ink-soft">{t.text}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      aria-label={label}
      className={cn("flex items-stretch overflow-hidden border-b border-line bg-card", className)}
      style={{ "--marquee-gap": gap, "--marquee-duration": `${duration}s`, ...style } as CSSProperties}
      {...props}
    >
      <span className="z-10 inline-flex flex-none items-center gap-1.5 bg-ink px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.1em] text-paper">
        <span aria-hidden="true" className="size-[7px] rounded-full bg-sage-tint" />
        {tag}
      </span>
      <div
        tabIndex={0}
        aria-label={`${label}, scroll to read`}
        role="region"
        className="group/ticker relative flex min-w-0 flex-1 overflow-hidden pl-5 motion-reduce:overflow-x-auto"
        style={{ maskImage: "linear-gradient(to right, transparent, black 3%, black 94%, transparent)" }}
      >
        <div
          className={cn(
            "flex w-max shrink-0 gap-(--marquee-gap) py-2.5",
            "animate-marquee group-hover/ticker:[animation-play-state:paused] group-focus-within/ticker:[animation-play-state:paused] motion-reduce:animate-none",
          )}
          style={{ animationPlayState: paused ? "paused" : undefined, animationDirection: direction === "right" ? "reverse" : undefined }}
        >
          {group(0)}
          {group(1)}
        </div>
      </div>
    </section>
  );
}
