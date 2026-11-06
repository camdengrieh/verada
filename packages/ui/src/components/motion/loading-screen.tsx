// Adapted from two 21st.dev preloaders: @kedhareswer/animator-title-preloader (id 38994), whose load
// is staged as a drawing pipeline (rough sketch, ink, paint, final), and @gaxocif204/preloader
// (id 13967), which lifts away with a curved trailing edge once the page is ready. Rebuilt on
// motion/react with the Varada mark, a watercolour Wash and status copy for config + mixnet start-up;
// GSAP, WebGL and the original palettes are gone.
"use client";

import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { LogoMark } from "@varada/ui/components/varada/logo-mark";
import { BrushUnderline, PaperGrain, Wash, type WashBlob } from "@varada/ui/components/varada/watercolour";
import { cn } from "@varada/ui/lib/utils";

export const DEFAULT_LOADING_MESSAGES = ["Loading configuration", "Connecting privately through the mixnet…", "Reading the chain"];

export type LoadingStepStatus = "pending" | "active" | "done" | "error";

export interface LoadingStep {
  id: string;
  label: string;
  status: LoadingStepStatus;
}

const BLOOM: WashBlob[] = [
  { cx: 220, cy: 110, rx: 150, ry: 70, color: "var(--ochre)", opacity: 0.32 },
  { cx: 380, cy: 80, rx: 140, ry: 60, color: "var(--sky)", opacity: 0.3 },
  { cx: 320, cy: 140, rx: 160, ry: 55, color: "var(--sage)", opacity: 0.26 },
];

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const EASE_LIFT = [0.76, 0, 0.24, 1] as const;

/** Rotates through `messages` every `interval` ms while `active`. */
function useRotatingIndex(length: number, interval: number, active: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || length < 2) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % length), interval);
    return () => window.clearInterval(t);
  }, [active, interval, length]);
  return length ? index % length : 0;
}

interface InkedMarkProps {
  size: number;
  reduced: boolean;
  /** Loop the inking (inline loaders) instead of inking once and breathing. */
  loop?: boolean;
}

/**
 * The mudra mark arriving the way a painting does: a pencil ring sketched first, then ink soaking
 * outward through the hand and ring, over a wash that blooms behind it.
 */
function InkedMark({ size, reduced, loop = false }: InkedMarkProps) {
  const mask = "radial-gradient(circle at 46% 58%, black var(--ink-r), transparent calc(var(--ink-r) + 16%))";
  return (
    <div aria-hidden="true" className="relative grid place-items-center" style={{ width: size, height: size }}>
      {/* The wash blooms once, then breathes. */}
      <motion.div
        className="absolute -inset-[70%]"
        initial={reduced ? false : { scale: 0.35, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduced ? { duration: 0 } : { duration: 1.4, ease: EASE_OUT }}
      >
        <motion.div
          className="size-full"
          animate={reduced ? undefined : { scale: [1, 1.06, 1], rotate: [0, 2, 0] }}
          transition={reduced ? undefined : { duration: 4.5, delay: 1.4, ease: "easeInOut", repeat: Infinity }}
        >
          <Wash blobs={BLOOM} bleed={46} className="size-full" />
        </motion.div>
      </motion.div>

      {/* Pencil underdrawing: the ring is sketched before the ink arrives. */}
      {reduced ? null : (
        <motion.svg
          viewBox="0 0 708 708"
          className="absolute inset-0 size-full"
          initial={{ opacity: 1 }}
          animate={{ opacity: loop ? [1, 1, 0.2, 1] : [1, 1, 0] }}
          transition={{ duration: loop ? 2.6 : 2, times: loop ? [0, 0.4, 0.7, 1] : [0, 0.65, 1], repeat: loop ? Infinity : 0 }}
        >
          <motion.circle
            cx={354}
            cy={354}
            r={322}
            fill="none"
            stroke="var(--ink-muted)"
            strokeWidth={5}
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: EASE_OUT, repeat: loop ? Infinity : 0, repeatDelay: loop ? 1.7 : 0 }}
          />
        </motion.svg>
      )}

      {/* Ink soaks outward from the palm through the hand and ring. */}
      <motion.div
        className="relative text-ink"
        style={{ "--ink-r": reduced ? "120%" : "0%", maskImage: mask, WebkitMaskImage: mask } as CSSProperties}
        initial={reduced ? false : { "--ink-r": "0%" }}
        animate={reduced ? undefined : loop ? { "--ink-r": ["0%", "120%", "120%", "0%"] } : { "--ink-r": "120%", scale: [1, 1, 1.03, 1] }}
        transition={
          reduced
            ? undefined
            : loop
              ? { duration: 2.6, times: [0, 0.45, 0.85, 1], ease: "easeInOut", repeat: Infinity }
              : { "--ink-r": { duration: 1.3, delay: 0.45, ease: EASE_OUT }, scale: { duration: 3.6, delay: 1.8, repeat: Infinity, ease: "easeInOut" } }
        }
      >
        <LogoMark size={size} decorative />
      </motion.div>
    </div>
  );
}

function StepDot({ status }: { status: LoadingStepStatus }) {
  if (status === "done") {
    return (
      <span className="grid size-5 place-items-center rounded-full bg-sage text-paper">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid size-5 place-items-center rounded-full border-2",
        status === "active" && "border-ochre",
        status === "pending" && "border-line-strong",
        status === "error" && "border-terracotta bg-terracotta-tint",
      )}
    >
      {status === "active" ? <span className="size-2 rounded-full bg-ochre motion-safe:animate-pulse" /> : null}
    </span>
  );
}

export interface LoadingScreenProps {
  /** Flip to true once the app can render; the screen then lifts away. */
  ready: boolean;
  /** Status lines rotated under the mark. */
  messages?: string[];
  /** Milliseconds per status line. */
  interval?: number;
  /** Optional real progress (config, mixnet worker, first chain read). Announced to screen readers. */
  steps?: LoadingStep[];
  /** Accessible name of the loading state. */
  label?: string;
  /** `fixed` over the viewport (default) or `absolute` inside a positioned parent (previews). */
  fullScreen?: boolean;
  /** `lift` wipes up with a curved edge; `fade` dissolves. Reduced motion always fades quickly. */
  exit?: "lift" | "fade";
  /** Keep the screen up at least this long so a fast load doesn't flash it. */
  minVisibleMs?: number;
  /** Called once the exit transition has finished and the screen is gone. */
  onExited?: () => void;
  /** Extra content under the status (e.g. a retry button when a step fails). */
  children?: ReactNode;
  className?: string;
}

/**
 * Branded start-up screen: the mudra mark sketches and inks in over a blooming wash while status
 * lines rotate below. It is a `role="status"` region with `aria-busy` while loading; screen readers
 * hear the label and the active step, not every rotating line. Rotation and progress keep working
 * under reduced motion, but nothing moves and the exit is a short fade.
 */
export function LoadingScreen({
  ready,
  messages = DEFAULT_LOADING_MESSAGES,
  interval = 2400,
  steps,
  label = "Loading Varada",
  fullScreen = true,
  exit = "lift",
  minVisibleMs = 600,
  onExited,
  children,
  className,
}: LoadingScreenProps) {
  const reduced = usePrefersReducedMotion();
  const [holding, setHolding] = useState(minVisibleMs > 0);
  useEffect(() => {
    if (minVisibleMs <= 0) return;
    const t = window.setTimeout(() => setHolding(false), minVisibleMs);
    return () => window.clearTimeout(t);
  }, [minVisibleMs]);

  const visible = !ready || holding;
  const index = useRotatingIndex(messages.length, interval, visible);
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;

  const active = steps?.find((s) => s.status === "active" || s.status === "error");
  const doneCount = steps?.filter((s) => s.status === "done").length ?? 0;
  const spoken = active ? `${label}: ${active.label}` : `${label}…`;
  const lift = exit === "lift" && !reduced;

  return (
    <AnimatePresence onExitComplete={() => exitedRef.current?.()}>
      {visible ? (
        <motion.div
          key="varada-loading-screen"
          data-slot="loading-screen"
          role="status"
          aria-live="polite"
          aria-busy={!ready}
          className={cn(
            "inset-0 z-[80] grid place-items-center overflow-hidden bg-paper text-ink",
            fullScreen ? "fixed" : "absolute",
            className,
          )}
          initial={false}
          // Radii start as the same two-value type the lift animates to, so they interpolate.
          animate={{ y: 0, opacity: 1, borderBottomLeftRadius: "0% 0%", borderBottomRightRadius: "0% 0%" }}
          exit={
            lift
              ? { y: "-104%", borderBottomLeftRadius: "50% 14%", borderBottomRightRadius: "50% 14%", transition: { duration: 0.9, ease: EASE_LIFT } }
              : { opacity: 0, transition: { duration: reduced ? 0.12 : 0.45 } }
          }
        >
          <PaperGrain opacity={0.07} />
          <span className="sr-only">{spoken}</span>
          <motion.div
            className="relative flex flex-col items-center gap-6 px-6 text-center"
            exit={lift ? { opacity: 0, scale: 0.94, y: -12, transition: { duration: 0.35 } } : undefined}
          >
            <InkedMark size={fullScreen ? 132 : 96} reduced={reduced} />
            <div aria-hidden="true" className="flex flex-col items-center gap-1">
              <span className="font-display text-3xl font-semibold tracking-tight text-ink">Varada</span>
              <div className="relative h-7 min-w-64">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={index}
                    className="absolute inset-x-0 text-[15px] text-ink-soft"
                    initial={reduced ? false : { opacity: 0, y: 8, filter: "blur(3px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -8, filter: "blur(3px)" }}
                    transition={{ duration: 0.35, ease: EASE_OUT }}
                  >
                    {messages[index]}
                  </motion.p>
                </AnimatePresence>
              </div>
              <BrushUnderline className="-mt-1 h-3 w-40" color="var(--ochre)" />
            </div>

            {steps?.length ? (
              <div aria-hidden="true" className="flex w-full max-w-xs flex-col gap-3">
                <ol className="flex flex-col gap-2 text-left">
                  {steps.map((s) => (
                    <li key={s.id} className="flex items-center gap-2.5 text-sm">
                      <StepDot status={s.status} />
                      <span className={cn(s.status === "pending" ? "text-ink-muted" : "text-ink", s.status === "error" && "text-terracotta-strong")}>{s.label}</span>
                    </li>
                  ))}
                </ol>
                <div className="h-1.5 overflow-hidden rounded-full bg-sand">
                  <motion.div
                    className="h-full rounded-full bg-sage"
                    initial={false}
                    animate={{ width: `${(doneCount / steps.length) * 100}%` }}
                    transition={{ duration: reduced ? 0 : 0.6, ease: EASE_OUT }}
                  />
                </div>
              </div>
            ) : null}
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export interface PageLoaderProps {
  /** Visible and spoken text. */
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const PAGE_SIZES = { sm: 40, md: 64, lg: 88 } as const;

/** Inline loader for a section or panel: the mark inking in a loop beside a status label. */
export function PageLoader({ label = "Loading", size = "md", className }: PageLoaderProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div
      data-slot="page-loader"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("flex flex-col items-center justify-center gap-4 py-8 text-center", size === "sm" && "flex-row gap-3 py-3", className)}
    >
      <InkedMark size={PAGE_SIZES[size]} reduced={reduced} loop />
      <span className={cn("text-ink-soft", size === "sm" ? "text-sm" : "text-[15px]")}>{label}</span>
    </div>
  );
}
