// Adapted from 21st.dev @kevingirelli/marquee (id 35200). Uses the house `animate-marquee` keyframes; drag-to-scrub dropped.
"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@verada/ui/lib/utils";

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Live `prefers-reduced-motion` (false on the server and where matchMedia is missing). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(REDUCED).matches),
    () => false,
  );
}

export interface MarqueeProps extends ComponentProps<"div"> {
  /** Which way the content travels. */
  direction?: "left" | "right";
  /** Seconds for the content to travel its own length. */
  duration?: number;
  /** Space between items, and between the end of the content and its copy. Any CSS length. */
  gap?: string;
  /** Hold still while the pointer is over it (keyboard focus inside always pauses it). */
  pauseOnHover?: boolean;
  /** Hold it still from outside, e.g. while a dialog opened from it is up. */
  paused?: boolean;
  /** Fade the content out at both edges. */
  fade?: boolean;
  /** Repeat the children inside each copy, for short content in a wide strip. */
  repeat?: number;
  /** Names the strip; it becomes a focusable, hand-scrolled region under reduced motion. */
  label?: string;
}

/**
 * Seamless ticker for the live activity strip. One CSS transform animation over two identical
 * copies; the second copy is hidden from assistive tech and inert. It pauses on hover, on focus
 * within and while off screen. With `prefers-reduced-motion` it stands still as a scroll row.
 */
export function Marquee({
  direction = "left",
  duration = 40,
  gap = "1rem",
  pauseOnHover = true,
  paused = false,
  fade = true,
  repeat = 1,
  label = "Live activity",
  className,
  style,
  children,
  ...props
}: MarqueeProps) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const [inView, setInView] = useState(true);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true), { rootMargin: "100px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const copies = Math.max(1, Math.floor(repeat));
  const mask = fade && !reduced ? "linear-gradient(to right, transparent, black 8%, black 92%, transparent)" : undefined;
  const group = (hidden: boolean) => (
    <div
      data-slot="marquee-group"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      className={cn("flex shrink-0 items-center gap-[var(--marquee-gap)]", hidden && "motion-reduce:hidden")}
    >
      {Array.from({ length: copies }, (_, i) => (
        <div key={i} className="contents">
          {children}
        </div>
      ))}
    </div>
  );

  return (
    <div
      ref={root}
      data-slot="marquee"
      data-direction={direction}
      role={reduced ? "region" : undefined}
      aria-label={reduced ? label : undefined}
      tabIndex={reduced ? 0 : undefined}
      className={cn(
        "group/marquee flex overflow-hidden motion-reduce:overflow-x-auto",
        reduced && "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      style={
        {
          "--marquee-gap": gap,
          "--marquee-duration": `${duration}s`,
          maskImage: mask,
          WebkitMaskImage: mask,
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      <div
        data-slot="marquee-track"
        className={cn(
          "flex w-max shrink-0 gap-[var(--marquee-gap)] motion-safe:animate-marquee",
          "group-focus-within/marquee:[animation-play-state:paused]",
          pauseOnHover && "group-hover/marquee:[animation-play-state:paused]",
        )}
        style={{
          animationDirection: direction === "right" ? "reverse" : undefined,
          animationPlayState: paused || !inView ? "paused" : undefined,
        }}
      >
        {group(false)}
        {group(true)}
      </div>
    </div>
  );
}
