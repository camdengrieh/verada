"use client";
// Adapted from 21st.dev @dillionverma/animated-beam (Magic UI, id 919): a curved path between two
// elements, measured against a container and re-measured on resize, with a gradient pulse
// travelling along it. Varada version: the path is a pencilled dashed line on paper, the pulse is
// a pigment drop (terracotta → sage by default: coin → cause), and under reduced motion the path
// is simply inked in with no travel. Use it to show money flowing coin → cause pool → charity.
import { motion } from "motion/react";
import { useEffect, useId, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface AnimatedBeamProps {
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  /** Positive bends the curve upward, negative downward (px). */
  curvature?: number;
  /** Travel from `to` back to `from`. */
  reverse?: boolean;
  /** Seconds per pulse, and before the first. */
  duration?: number;
  delay?: number;
  /** Pigment at the head and tail of the pulse. */
  startColor?: string;
  endColor?: string;
  width?: number;
  className?: string;
}

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 3.2,
  delay = 0,
  startColor = "var(--terracotta)",
  endColor = "var(--sage)",
  width = 3,
  className,
}: AnimatedBeamProps) {
  const id = `beam-${useId().replace(/:/g, "")}`;
  const reduced = usePrefersReducedMotion();
  const [d, setD] = useState("");
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const a = fromRef.current;
      const b = toRef.current;
      if (!c || !a || !b) return;
      const cr = c.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const x1 = ar.left - cr.left + ar.width / 2;
      const y1 = ar.top - cr.top + ar.height / 2;
      const x2 = br.left - cr.left + br.width / 2;
      const y2 = br.top - cr.top + br.height / 2;
      setBox({ w: cr.width, h: cr.height });
      setD(`M ${x1},${y1} Q ${(x1 + x2) / 2},${(y1 + y2) / 2 - curvature} ${x2},${y2}`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef, fromRef, toRef, curvature]);

  const travel = reverse ? { x1: ["90%", "-10%"], x2: ["100%", "0%"] } : { x1: ["10%", "110%"], x2: ["0%", "100%"] };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      width={box.w}
      height={box.h}
      viewBox={`0 0 ${box.w} ${box.h}`}
      className={cn("pointer-events-none absolute left-0 top-0", className)}
    >
      <path d={d} stroke="var(--line-strong)" strokeWidth={1.5} strokeDasharray="2 6" strokeLinecap="round" />
      <path d={d} stroke={`url(#${id})`} strokeWidth={width} strokeLinecap="round" />
      <defs>
        {reduced ? (
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" x2={box.w} y1="0" y2="0">
            <stop stopColor={startColor} stopOpacity="0.55" />
            <stop offset="100%" stopColor={endColor} stopOpacity="0.55" />
          </linearGradient>
        ) : (
          <motion.linearGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            initial={{ x1: "0%", x2: "0%", y1: "0%", y2: "0%" }}
            animate={{ ...travel, y1: ["0%", "0%"], y2: ["0%", "0%"] }}
            transition={{ delay, duration, ease: [0.4, 0, 0.2, 1], repeat: Infinity, repeatDelay: 0.4 }}
          >
            <stop stopColor={startColor} stopOpacity="0" />
            <stop stopColor={startColor} />
            <stop offset="35%" stopColor={endColor} />
            <stop offset="100%" stopColor={endColor} stopOpacity="0" />
          </motion.linearGradient>
        )}
      </defs>
    </svg>
  );
}

/** A round paper node to connect with beams. Pass `ref` from useRef. */
export function BeamNode({ className, children, label, ...props }: ComponentProps<"div"> & { label?: ReactNode }) {
  return (
    <div className="relative z-10 flex flex-col items-center gap-2">
      <div
        className={cn("grid size-14 place-items-center rounded-full border border-line-strong bg-paper-card shadow-paper [&_img]:rounded-full", className)}
        {...props}
      >
        {children}
      </div>
      {label ? <span className="text-center text-sm font-semibold text-ink">{label}</span> : null}
    </div>
  );
}
