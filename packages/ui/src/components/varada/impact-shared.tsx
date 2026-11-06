// Adapted from 21st.dev @good-listener/liquid-button (id 11596, demo 23994): a liquid level that rises
// on a slow ease, with two counter-moving wave layers at the surface and reduced-motion support. Here
// the liquid is watercolour pigment (turbulence-displaced edges) instead of a gradient, and the level
// is data, not hover.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Money for the impact components: cents under $1,000, whole dollars above, compact on request. */
export function formatUsd(value: number, { compact = false }: { compact?: boolean } = {}): string {
  const abs = Math.abs(value);
  if (compact && abs >= 10_000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(value);
  }
  const cents = abs < 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(value);
}

/** Intl options matching `formatUsd`, for NumberTicker. */
export function usdFormatOptions(value: number, compact = false): Intl.NumberFormatOptions {
  if (compact && Math.abs(value) >= 10_000) return { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 };
  const cents = Math.abs(value) < 1000;
  return { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 };
}

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Text for a polite live region that changes at most once per `interval` ms, so a live counter is
 * spoken now and then, not on every tick. The latest value always wins when the window reopens.
 */
export function useThrottledAnnouncement(text: string, interval = 30_000): string {
  const [spoken, setSpoken] = useState("");
  const last = useRef(0);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    const now = Date.now();
    const wait = last.current === 0 ? 0 : Math.max(0, last.current + interval - now);
    // The first value isn't announced (it's on screen and read with the page); later ones are.
    if (last.current === 0) {
      last.current = now;
      return;
    }
    const t = setTimeout(() => {
      last.current = Date.now();
      setSpoken(latest.current);
    }, wait);
    return () => clearTimeout(t);
  }, [text, interval]);
  return spoken;
}

export interface InkFillProps extends Omit<ComponentProps<"div">, "children"> {
  /** 0–1. */
  level: number;
  /** Pigment, any CSS colour or token. */
  pigment?: string;
  /** Second pigment blended into the deep end. */
  deep?: string;
  /** Wave height in px. 0 for a flat surface. */
  wave?: number;
  /** Keep the surface moving (off under reduced motion). */
  live?: boolean;
}

/**
 * Pigment rising like ink in water: a level that eases up to `level`, a soft wavy surface made of two
 * drifting wave layers, and watercolour edges. Decorative; put it inside a `relative overflow-hidden`
 * shape and say the value in text.
 */
export function InkFill({ level, pigment = "var(--sage)", deep = "var(--sky)", wave = 8, live = true, className, ...props }: InkFillProps) {
  const reduced = useReducedMotion();
  const id = `ink-${useId().replace(/:/g, "")}`;
  const pct = clamp01(level) * 100;
  const moving = live && !reduced;
  // Four periods across a 200%-wide strip; sliding it by half loops seamlessly.
  const path = (amp: number) =>
    `M0 ${amp} Q12.5 0 25 ${amp} T50 ${amp} T75 ${amp} T100 ${amp} T125 ${amp} T150 ${amp} T175 ${amp} T200 ${amp} V${amp * 2 + 2} H0 Z`;
  return (
    <div aria-hidden="true" data-slot="ink-fill" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} {...props}>
      <svg width="0" height="0" className="absolute">
        <filter id={id} x="-5%" y="-100%" width="110%" height="300%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={3} seed={11} />
          <feDisplacementMap in="SourceGraphic" scale={10} />
        </filter>
      </svg>
      <motion.div
        className="absolute inset-x-0 bottom-0"
        initial={reduced ? false : { height: "0%" }}
        animate={{ height: `${pct}%` }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 28, damping: 14, mass: 1.2 }}
        style={{ filter: `url(#${id})` }}
      >
        {wave > 0 && pct > 0 ? (
          <>
            <motion.svg
              viewBox={`0 0 200 ${wave * 2 + 2}`}
              preserveAspectRatio="none"
              className="absolute bottom-[calc(100%-1px)] left-0 w-[200%]"
              style={{ height: wave * 2 + 2 }}
              animate={moving ? { x: ["0%", "-50%"] } : undefined}
              transition={moving ? { duration: 7, ease: "linear", repeat: Infinity } : undefined}
            >
              <path d={path(wave)} fill={pigment} fillOpacity={0.18} />
            </motion.svg>
            <motion.svg
              viewBox={`0 0 200 ${wave * 2 + 2}`}
              preserveAspectRatio="none"
              className="absolute bottom-[calc(100%-1px)] left-0 w-[200%]"
              style={{ height: wave * 1.4 + 2 }}
              animate={moving ? { x: ["-50%", "0%"] } : undefined}
              transition={moving ? { duration: 5, ease: "linear", repeat: Infinity } : undefined}
            >
              <path d={path(wave)} fill={pigment} fillOpacity={0.34} />
            </motion.svg>
          </>
        ) : null}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(to bottom, color-mix(in oklab, ${pigment} 34%, transparent), color-mix(in oklab, ${deep} 30%, color-mix(in oklab, ${pigment} 40%, transparent)))`,
          }}
        />
      </motion.div>
    </div>
  );
}
