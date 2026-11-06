"use client";
// Adapted from 21st.dev @cnippet-dev/scroll-progress (id 18717): a spring-smoothed bar that tracks
// scroll position of the page or of a scrollable container. Varada version: a `brush` style that
// paints an ochre stroke across as you read, a plain `bar` in terracotta, a real progressbar role
// with a whole-percent value, and no spring under reduced motion.
import { motion, useMotionValueEvent, useScroll, useSpring, type MotionValue } from "motion/react";
import { useId, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface ScrollProgressProps {
  /** Track this scrollable element instead of the page. */
  container?: RefObject<HTMLElement | null>;
  /** Accessible name, e.g. "Reading progress". */
  label?: string;
  variant?: "bar" | "brush";
  /** `fixed` pins it to the top of the viewport; `inline` (default) places it in the flow. */
  position?: "fixed" | "inline";
  className?: string;
}

function Brush({ progress }: { progress: MotionValue<number> }) {
  const id = `sp-${useId().replace(/:/g, "")}`;
  return (
    <svg aria-hidden="true" viewBox="0 0 300 12" preserveAspectRatio="none" className="block h-3 w-full overflow-visible">
      <filter id={id}>
        <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves={2} seed={9} />
        <feDisplacementMap in="SourceGraphic" scale={3} />
      </filter>
      <path d="M3 6 C 80 3, 200 9, 297 5" stroke="var(--line)" strokeWidth="5" strokeLinecap="round" fill="none" />
      <motion.path
        d="M3 6 C 80 3, 200 9, 297 5"
        stroke="var(--ochre)"
        strokeOpacity="0.85"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
        filter={`url(#${id})`}
        style={{ pathLength: progress }}
      />
    </svg>
  );
}

/** How far through the page (or a panel) the reader is. */
export function ScrollProgress({ container, label = "Reading progress", variant = "bar", position = "inline", className }: ScrollProgressProps) {
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll(container ? { container } : undefined);
  const smooth = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.001 });
  const progress = reduced ? scrollYProgress : smooth;
  const [pct, setPct] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const next = Math.round(Math.max(0, Math.min(1, v)) * 100);
    setPct((p) => (p === next ? p : next));
  });

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% read`}
      data-slot="scroll-progress"
      className={cn(position === "fixed" ? "fixed inset-x-0 top-0 z-50" : "relative w-full", className)}
    >
      {variant === "brush" ? (
        <Brush progress={progress} />
      ) : (
        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <motion.div className="h-full origin-left rounded-full bg-primary" style={{ scaleX: progress }} />
        </div>
      )}
    </div>
  );
}
