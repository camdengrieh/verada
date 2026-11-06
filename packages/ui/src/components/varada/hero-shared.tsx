// Pointer parallax adapted from 21st.dev @danielpetho/parallax-floating (id 1332, demo 656): layers
// registered with a depth ease toward the pointer every animation frame. Here it runs on motion
// springs, only for fine pointers and never under reduced motion. Stat strip and actions follow the
// stats row of 21st.dev @ravikatiyar162/hero-section-9 (id 8737). Varada tokens throughout.
"use client";

import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { createContext, useContext, useEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";
import { NumberTicker } from "@varada/ui/components/motion/number-ticker";
import { Button, buttonVariants, type ButtonEffect } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";
import { DefaultLink, type LinkComponent } from "./shared";
import { BrushUnderline, Wash, type WashBlob } from "./watercolour";

export interface HeroStat {
  label: string;
  /** Numbers count up with NumberTicker; strings show as they are. */
  value: number | string;
  format?: Intl.NumberFormatOptions;
  /** Marks a stat that updates live (small pulsing dot). */
  live?: boolean;
}

export interface HeroAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "cause" | "outline" | "soft" | "ink" | "ghost";
  effect?: ButtonEffect;
  icon?: ReactNode;
}

export type HeroHeadingLevel = 1 | 2 | 3;

/** A stat strip: label over value, hairline dividers between on wide containers. */
export function HeroStats({ stats, className, tone = "paper" }: { stats: HeroStat[]; className?: string; tone?: "paper" | "card" }) {
  return (
    <dl
      data-slot="hero-stats"
      className={cn(
        "m-0 grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border border-line p-4 @lg:flex @lg:flex-wrap @lg:items-stretch @lg:gap-5",
        tone === "card" ? "bg-card" : "bg-paper-card/80",
        className,
      )}
    >
      {stats.map((s, i) => (
        <div key={s.label} className="flex min-w-0 items-stretch gap-5">
          {i > 0 ? <Divider orientation="vertical" className="hidden @lg:flex" /> : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
              {s.live ? (
                <span aria-hidden="true" className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-sage opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex size-2 rounded-full bg-sage" />
                </span>
              ) : null}
              {s.label}
              {s.live ? <span className="sr-only"> (live)</span> : null}
            </dt>
            <dd className="m-0 text-xl font-semibold text-ink @lg:text-2xl">
              {typeof s.value === "number" ? <NumberTicker value={s.value} format={s.format} /> : <span className="num">{s.value}</span>}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

/** Primary / secondary calls to action; links when `href` is set, buttons otherwise. */
export function HeroActions({ actions, LinkComponent = DefaultLink, className }: { actions: HeroAction[]; LinkComponent?: LinkComponent; className?: string }) {
  if (!actions.length) return null;
  return (
    <div className={cn("flex flex-col gap-2 @sm:flex-row @sm:flex-wrap", className)}>
      {actions.map((a, i) => {
        const variant = a.variant ?? (i === 0 ? "primary" : "outline");
        return a.href ? (
          <LinkComponent key={a.label} href={a.href} className={cn(buttonVariants({ variant, size: "lg" }))}>
            {a.icon}
            {a.label}
          </LinkComponent>
        ) : (
          <Button key={a.label} variant={variant} size="lg" effect={a.effect} onClick={a.onClick}>
            {a.icon}
            {a.label}
          </Button>
        );
      })}
    </div>
  );
}

/** Splits a headline at `highlight` and paints a brush stroke under that word, drawn in on mount. */
export function HighlightedHeadline({ text, highlight, color = "var(--ochre)" }: { text: string; highlight?: string; color?: string }) {
  const reduced = useReducedMotion();
  const at = highlight ? text.indexOf(highlight) : -1;
  if (!highlight || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="relative inline-block whitespace-nowrap">
        <span className="relative z-[1]">{highlight}</span>
        <motion.span
          aria-hidden="true"
          className="absolute -bottom-1 left-[-4%] block h-[0.42em] w-[108%]"
          initial={reduced ? false : { clipPath: "inset(0 100% 0 0)" }}
          animate={{ clipPath: "inset(0 0% 0 0)" }}
          transition={{ duration: 0.7, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <BrushUnderline color={color} className="size-full" />
        </motion.span>
      </span>
      {text.slice(at + highlight.length)}
    </>
  );
}

/** Heading element for a level (heroes default to h1 on a page; galleries pass 2 or 3). */
export function HeroHeading({ level = 1, className, children, ...props }: { level?: HeroHeadingLevel } & ComponentProps<"h1">) {
  const Tag = `h${level}` as const;
  return (
    <Tag className={cn("m-0 font-display font-semibold tracking-tight text-ink", className)} {...props}>
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Pointer parallax                                                                                  */

interface ParallaxCtx {
  x: MotionValue<number>;
  y: MotionValue<number>;
}
const ParallaxContext = createContext<ParallaxCtx | null>(null);

/** Tracks the pointer over `ref` as -0.5…0.5 on each axis, springing back to centre when it leaves. */
function usePointer(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const x = useSpring(rawX, { stiffness: 60, damping: 18, mass: 0.6 });
  const y = useSpring(rawY, { stiffness: 60, damping: 18, mass: 0.6 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      rawX.set((e.clientX - r.left) / r.width - 0.5);
      rawY.set((e.clientY - r.top) / r.height - 0.5);
    };
    const leave = () => {
      rawX.set(0);
      rawY.set(0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [ref, enabled, rawX, rawY]);
  return { x, y };
}

/** Wrap a hero's art; `ParallaxLayer`s inside drift against the pointer by their depth. */
export function Parallax({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const pointer = usePointer(ref, !reduced);
  return (
    <ParallaxContext.Provider value={pointer}>
      <div ref={ref} className={cn("relative", className)}>
        {children}
      </div>
    </ParallaxContext.Provider>
  );
}

/** A layer that moves `depth × 12px` per half-container of pointer travel (negative depth moves against it). */
export function ParallaxLayer({ depth = 1, className, children }: { depth?: number; className?: string; children: ReactNode }) {
  const ctx = useContext(ParallaxContext);
  const fallback = useMotionValue(0);
  const x = useTransform(ctx?.x ?? fallback, (v) => v * depth * 24);
  const y = useTransform(ctx?.y ?? fallback, (v) => v * depth * 24);
  return (
    <motion.div className={cn("will-change-transform", className)} style={{ x, y }}>
      {children}
    </motion.div>
  );
}

/** Watercolour wash that drifts slowly behind a hero (still under reduced motion). */
export function DriftingWash({ blobs, className, seed }: { blobs?: WashBlob[]; className?: string; seed?: number }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      aria-hidden="true"
      className={cn("pointer-events-none absolute -inset-[8%] -z-10", className)}
      animate={reduced ? undefined : { x: ["0%", "2.5%", "-1.5%", "0%"], y: ["0%", "-2%", "1.5%", "0%"], rotate: [0, 1.2, -0.8, 0] }}
      transition={reduced ? undefined : { duration: 26, ease: "easeInOut", repeat: Infinity }}
    >
      <Wash className="size-full" blobs={blobs} seed={seed} bleed={46} />
    </motion.div>
  );
}

/** Staggered entrance for hero copy (from hero-section-9's container/item variants). */
export const heroContainer = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.09 } } } as const;
export const heroItem = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
} as const;

/** Props for `motion.div` that run the entrance, or nothing under reduced motion. */
export function useHeroEntrance() {
  const reduced = useReducedMotion();
  return {
    container: reduced ? {} : { variants: heroContainer, initial: "hidden" as const, animate: "visible" as const },
    item: reduced ? {} : { variants: heroItem },
  };
}
