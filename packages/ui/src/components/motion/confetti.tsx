// Adapted from 21st.dev @dillionverma/confetti (id 843): canvas-confetti fired from an element's
// position, plus its custom-shape and side-cannon recipes. The colours come from the Varada tokens
// at runtime, the shapes are painted dabs, petals, coins and hearts drawn as paths (no emoji), and
// every burst is skipped under prefers-reduced-motion.
"use client";

import confetti, { type Options as ConfettiOptions, type Shape } from "canvas-confetti";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Button, type ButtonProps } from "@varada/ui/components/ui/button";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

export type ConfettiPreset = "launch" | "vote" | "donation";

/** Where a burst starts: an element (its centre), a viewport point in px, or a 0–1 fraction. */
export type ConfettiOrigin = Element | { x: number; y: number; unit?: "px" | "fraction" };

export interface FireConfettiOptions {
  preset?: ConfettiPreset;
  origin?: ConfettiOrigin;
  /** Token names (`--sage`) or hex colours; defaults to the preset's palette. */
  colors?: string[];
  /** Multiplies particle counts (0.5 for a smaller burst). */
  intensity?: number;
  /** Above drawers (z-50) and dialogs; toasts stay on top. */
  zIndex?: number;
  /** Called instead of the burst when the visitor prefers reduced motion, e.g. to show a static state. */
  onReducedMotion?: () => void;
}

export interface ConfettiHandle {
  /** False when nothing was drawn (reduced motion, no window). */
  fired: boolean;
  /** Drops any shots of this burst that haven't fired yet. */
  cancel: () => void;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

const PALETTES: Record<ConfettiPreset, string[]> = {
  launch: ["--terracotta", "--ochre", "--sage", "--sky", "--terracotta-strong", "--ochre-ink"],
  vote: ["--sage", "--sage", "--sage-ink", "--ochre", "--sky"],
  donation: ["--ochre", "--ochre", "--ochre-ink", "--terracotta", "--sage"],
};

/** True when the visitor asked for less motion (and on the server). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Resolves token names to hex for the canvas (canvas-confetti only parses hex). Reads from `el` so a
 * `.dark` subtree gets its own palette. Unknown or non-hex values are dropped.
 */
export function readTokenColors(tokens: string[], el?: Element | null): string[] {
  if (typeof window === "undefined") return [];
  const target = el ?? document.documentElement;
  const style = window.getComputedStyle(target);
  const out: string[] = [];
  for (const token of tokens) {
    const raw = token.startsWith("--") ? style.getPropertyValue(token).trim() : token.trim();
    if (HEX.test(raw)) out.push(raw);
  }
  return out;
}

// Shapes are built lazily (Path2D and DOMMatrix only exist in a browser) and cached.
let shapeCache: Partial<Record<"dab" | "petal" | "heart" | "coin", Shape>> | null = null;
function shapes() {
  if (shapeCache) return shapeCache;
  shapeCache = {};
  try {
    // A loaded-brush dab, a leaf-like petal, a heart and a milled coin.
    shapeCache.dab = confetti.shapeFromPath({ path: "M1 5 C2 1 8 0 11 2 C14 4 13 9 9 10 C6 11 2 10 1 7 Z" });
    shapeCache.petal = confetti.shapeFromPath({ path: "M6 0 C10 3 10 10 6 14 C2 10 2 3 6 0 Z" });
    shapeCache.heart = confetti.shapeFromPath({
      path: "M6 11 C6 11 0 7 0 3.5 C0 1.5 1.5 0 3.2 0 C4.4 0 5.4 .7 6 1.7 C6.6 .7 7.6 0 8.8 0 C10.5 0 12 1.5 12 3.5 C12 7 6 11 6 11 Z",
    });
    shapeCache.coin = confetti.shapeFromPath({
      path: "M6 0 A6 6 0 1 0 6 12 A6 6 0 1 0 6 0 Z M6 2.5 A3.5 3.5 0 1 1 6 9.5 A3.5 3.5 0 1 1 6 2.5 Z",
    });
  } catch {
    // Older engines without Path2D: the presets fall back to circles and squares.
  }
  return shapeCache;
}

function pick(...list: (Shape | undefined)[]): Shape[] {
  const found = list.filter((s): s is Shape => s !== undefined);
  return found.length ? found : ["circle", "square"];
}

function toFraction(origin: ConfettiOrigin | undefined): { x: number; y: number } {
  if (typeof window === "undefined" || origin === undefined) return { x: 0.5, y: 0.6 };
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  if (typeof Element !== "undefined" && origin instanceof Element) {
    const r = origin.getBoundingClientRect();
    return { x: (r.left + r.width / 2) / w, y: (r.top + r.height / 2) / h };
  }
  const point = origin as { x: number; y: number; unit?: "px" | "fraction" };
  if (point.unit === "fraction") return { x: point.x, y: point.y };
  return { x: point.x / w, y: point.y / h };
}

type Shot = { at: number; options: ConfettiOptions };

function recipe(preset: ConfettiPreset, origin: { x: number; y: number }, colors: string[], intensity: number): Shot[] {
  const s = shapes();
  const n = (count: number) => Math.max(1, Math.round(count * intensity));
  const base: ConfettiOptions = { origin, colors: colors.length ? colors : undefined, disableForReducedMotion: true };
  switch (preset) {
    case "launch":
      // A wide painted-palette burst, then two cannons from the sides, then a slow fall of petals.
      return [
        { at: 0, options: { ...base, particleCount: n(110), spread: 100, startVelocity: 48, scalar: 1.15, ticks: 260, shapes: pick(s.dab, "square", "circle") } },
        { at: 160, options: { ...base, origin: { x: 0, y: 0.75 }, angle: 60, particleCount: n(60), spread: 60, startVelocity: 62, ticks: 280, shapes: pick(s.dab, "square") } },
        { at: 160, options: { ...base, origin: { x: 1, y: 0.75 }, angle: 120, particleCount: n(60), spread: 60, startVelocity: 62, ticks: 280, shapes: pick(s.dab, "square") } },
        { at: 420, options: { ...base, particleCount: n(50), spread: 160, startVelocity: 26, gravity: 0.6, drift: 0.3, scalar: 1.3, ticks: 320, shapes: pick(s.petal, "circle") } },
      ];
    case "vote":
      // Gentle: a handful of petals that float rather than fly.
      return [
        { at: 0, options: { ...base, particleCount: n(34), spread: 70, startVelocity: 24, gravity: 0.5, decay: 0.92, drift: -0.2, scalar: 1.35, ticks: 280, shapes: pick(s.petal) } },
        { at: 140, options: { ...base, particleCount: n(22), spread: 90, startVelocity: 18, gravity: 0.45, decay: 0.92, drift: 0.25, scalar: 1.1, ticks: 300, shapes: pick(s.petal, "circle") } },
      ];
    case "donation":
      // Coins and hearts rising from the button and tumbling back down.
      return [
        { at: 0, options: { ...base, particleCount: n(36), spread: 75, startVelocity: 34, gravity: 0.9, scalar: 1.5, ticks: 240, shapes: pick(s.coin, "circle") } },
        { at: 120, options: { ...base, particleCount: n(20), spread: 95, startVelocity: 26, gravity: 0.7, scalar: 1.6, ticks: 260, shapes: pick(s.heart, "circle") } },
      ];
  }
}

/**
 * Fires a Varada celebration. Uses canvas-confetti's own full-screen canvas, which never takes
 * pointer events and removes itself when the last particle lands. Returns a handle whose `fired`
 * is false when the burst was skipped for reduced motion.
 */
export function fireConfetti({ preset = "launch", origin, colors, intensity = 1, zIndex = 70, onReducedMotion }: FireConfettiOptions = {}): ConfettiHandle {
  const none: ConfettiHandle = { fired: false, cancel: () => {} };
  if (typeof window === "undefined") return none;
  if (prefersReducedMotion()) {
    onReducedMotion?.();
    return none;
  }
  const el = typeof Element !== "undefined" && origin instanceof Element ? origin : null;
  const palette = readTokenColors(colors ?? PALETTES[preset], el);
  const shots = recipe(preset, toFraction(origin), palette, intensity);
  if (preset === "donation" && shots[0]) {
    // Coins stay gold whatever palette was passed; hearts take the palette.
    const gold = readTokenColors(["--ochre", "--ochre-ink"], el);
    shots[0].options.colors = gold.length ? gold : palette.length ? palette : undefined;
  }
  const timers: number[] = [];
  for (const shot of shots) {
    const run = () => void confetti({ zIndex, ...shot.options });
    if (shot.at === 0) run();
    else timers.push(window.setTimeout(run, shot.at));
  }
  return { fired: true, cancel: () => timers.forEach((t) => window.clearTimeout(t)) };
}

/** Clears every particle on screen (e.g. on route change). */
export function stopAllConfetti() {
  confetti.reset();
}

export interface UseConfettiOptions extends Omit<FireConfettiOptions, "origin"> {}

/**
 * `fire(target?)` bursts from an element, a click event's target or a point; pending shots are
 * dropped on unmount. `reduced` mirrors the media query, for showing a static celebration instead.
 */
export function useConfetti(defaults: UseConfettiOptions = {}) {
  const reduced = usePrefersReducedMotion();
  const handles = useRef<ConfettiHandle[]>([]);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  useEffect(() => {
    const list = handles.current;
    return () => list.forEach((h) => h.cancel());
  }, []);

  const fire = useCallback((target?: ConfettiOrigin | MouseEvent<Element>, overrides: UseConfettiOptions = {}) => {
    const origin = target && "currentTarget" in target ? (target.currentTarget as Element) : (target as ConfettiOrigin | undefined);
    const handle = fireConfetti({ ...defaultsRef.current, ...overrides, origin });
    if (handle.fired) handles.current.push(handle);
    return handle;
  }, []);

  return { fire, reduced };
}

export interface ConfettiButtonProps extends ButtonProps {
  preset?: ConfettiPreset;
  confetti?: Omit<FireConfettiOptions, "origin" | "preset">;
  /** How long the static celebration shows under reduced motion (ms). */
  staticMs?: number;
}

/**
 * A Button that bursts confetti from itself after its own onClick (unless that calls
 * preventDefault). With reduced motion it shows a static painted sparkle for a moment instead.
 */
export function ConfettiButton({ preset = "launch", confetti: options, staticMs = 2400, onClick, className, children, ...props }: ConfettiButtonProps) {
  const { fire } = useConfetti({ preset, ...options });
  const [celebrated, setCelebrated] = useState(false);

  useEffect(() => {
    if (!celebrated) return;
    const t = window.setTimeout(() => setCelebrated(false), staticMs);
    return () => window.clearTimeout(t);
  }, [celebrated, staticMs]);

  return (
    <Button
      data-celebrated={celebrated || undefined}
      className={cn(celebrated && "ring-2 ring-ochre ring-offset-2 ring-offset-background", className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        fire(event.currentTarget, { onReducedMotion: () => setCelebrated(true) });
      }}
      {...props}
    >
      {children}
      {celebrated ? <Sparkles aria-hidden="true" data-slot="confetti-static" /> : null}
    </Button>
  );
}
