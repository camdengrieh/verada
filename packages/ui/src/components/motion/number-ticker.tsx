// Adapted from 21st.dev @dillionverma/number-ticker (id 1282), with Intl formatting from @shadcnspace/number-ticker-05 (id 21515).
"use client";

import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

// useLayoutEffect warns during server rendering; static export pre-renders this file.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface NumberTickerProps extends Omit<ComponentProps<"span">, "children"> {
  value: number;
  /** Where the count starts the first time it scrolls into view. */
  from?: number;
  /** Intl.NumberFormat options, e.g. { style: "currency", currency: "USD" } or { notation: "compact" }. */
  format?: Intl.NumberFormatOptions;
  locale?: string;
  /** Seconds to wait after entering the viewport. */
  delay?: number;
}

/**
 * Counts up to `value` when it first scrolls into view, then springs between later values (live
 * stats). Screen readers get the final value once; the moving digits are hidden from them. With
 * reduced motion the number is simply shown. Server output is the final formatted value.
 */
export function NumberTicker({
  value,
  from = 0,
  format,
  locale = "en-US",
  delay = 0,
  className,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const formatKey = JSON.stringify(format ?? {});
  const formatter = useMemo(
    () => new Intl.NumberFormat(locale, JSON.parse(formatKey) as Intl.NumberFormatOptions),
    [locale, formatKey],
  );
  const motionValue = useMotionValue(from);
  const spring = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const started = useRef(false);

  // Before the first paint on the client, show the starting value so the count can run.
  useIsoLayoutEffect(() => {
    if (reduced || started.current || !ref.current) return;
    ref.current.textContent = formatter.format(from);
    // Only on mount: later value changes spring from wherever the ticker is.
  }, []);

  useEffect(() => {
    if (reduced) {
      motionValue.jump(value);
      spring.jump(value);
      if (ref.current) ref.current.textContent = formatter.format(value);
      return;
    }
    if (!inView) return;
    const wait = started.current ? 0 : delay * 1000;
    started.current = true;
    const timer = setTimeout(() => motionValue.set(value), wait);
    return () => clearTimeout(timer);
  }, [inView, reduced, value, delay, motionValue, spring, formatter]);

  useEffect(
    () =>
      spring.on("change", (latest) => {
        if (ref.current) ref.current.textContent = formatter.format(latest);
      }),
    [spring, formatter],
  );

  return (
    <span data-slot="number-ticker" className={cn("num inline-block", className)} {...props}>
      <span ref={ref} aria-hidden="true">
        {formatter.format(value)}
      </span>
      <span className="sr-only">{formatter.format(value)}</span>
    </span>
  );
}
