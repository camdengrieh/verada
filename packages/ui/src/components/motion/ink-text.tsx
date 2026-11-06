"use client";
// Adapted from 21st.dev @arihantcodes/ink, "Fluid Ink Morph" (id 18211): text that dissolves in
// from SVG turbulence and settles into crisp letters while its colour shifts. Varada version: the
// pigment starts as a wet ochre bloom and dries to ink, the text stays real (selectable, read by
// screen readers), the filter is removed once settled, and reduced motion skips straight to ink.
import { useInView } from "motion/react";
import { createElement, useEffect, useId, useRef, useState, type ElementType } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface InkTextProps {
  children: string;
  as?: ElementType;
  /** Milliseconds for the bloom to settle. */
  settleMs?: number;
  /** Wet colour → dry colour; tokens work. */
  from?: string;
  to?: string;
  /** Change this to play it again. */
  replay?: unknown;
  className?: string;
}

/** A word that blooms out of wet pigment and dries to ink. Best on display type. */
export function InkText({ children, as = "span", settleMs = 1600, from = "var(--ochre)", to = "var(--ink)", replay, className }: InkTextProps) {
  const id = `ink-${useId().replace(/:/g, "")}`;
  const ref = useRef<HTMLElement>(null);
  const turb = useRef<SVGFETurbulenceElement>(null);
  const disp = useRef<SVGFEDisplacementMapElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const reduced = usePrefersReducedMotion();
  const [wet, setWet] = useState(!reduced);
  const [dry, setDry] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setWet(false);
      setDry(true);
      return;
    }
    if (!inView) return;
    setWet(true);
    setDry(false);
    let raf = 0;
    let start = 0;
    // Let the wet colour paint for a frame, then let it dry over settleMs.
    const dryFrame = requestAnimationFrame(() => setDry(true));
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / settleMs);
      const ease = 1 - Math.pow(1 - p, 3);
      const freq = 0.09 + (0.004 - 0.09) * ease;
      turb.current?.setAttribute("baseFrequency", `${freq.toFixed(4)} ${(freq * 0.85).toFixed(4)}`);
      disp.current?.setAttribute("scale", (36 * (1 - ease)).toFixed(2));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setWet(false);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(dryFrame);
    };
  }, [inView, reduced, settleMs, replay]);

  return createElement(
    as,
    {
      ref,
      "data-slot": "ink-text",
      "data-wet": wet || undefined,
      className: cn("relative inline-block", className),
      style: {
        color: dry ? to : from,
        filter: wet ? `url(#${id})` : undefined,
        transition: reduced ? undefined : `color ${settleMs}ms cubic-bezier(0.2, 0.6, 0.12, 1)`,
      },
    },
    children,
    <svg key="f" aria-hidden="true" width="0" height="0" className="absolute">
      <filter id={id}>
        <feTurbulence ref={turb} type="fractalNoise" baseFrequency="0.09 0.0765" numOctaves={2} seed={5} />
        <feDisplacementMap ref={disp} in="SourceGraphic" scale="36" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>,
  );
}
