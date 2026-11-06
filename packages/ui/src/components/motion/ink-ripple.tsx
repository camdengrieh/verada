"use client";
// Adapted from 21st.dev @ddoemonn/ripple (id 23551): a press ripple from the exact pointer point
// (or the centre for Enter/Space) that grows while held and fades on release, with a headless
// hook. Varada version: the ripple is an ink drop with a feathered, bleeding edge (SVG turbulence)
// in the button's own pigment, and under reduced motion it is a brief flat tint instead.
import { motion } from "motion/react";
import { Slot } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { buttonVariants } from "@verada/ui/components/ui/button";
import { cn } from "@verada/ui/lib/utils";
import type { VariantProps } from "class-variance-authority";

interface Drop {
  id: number;
  x: number;
  y: number;
  r: number;
  released: boolean;
}

const MIN_VISIBLE = 220;
const FADE = 420;

/** Headless ripple state. Spread `bind` on the pressable element and render `drops` inside it. */
export function useInkRipple({ disabled = false, max = 3 }: { disabled?: boolean; max?: number } = {}) {
  const [drops, setDrops] = useState<Drop[]>([]);
  const seq = useRef(0);
  const born = useRef(new Map<number, number>());
  const timers = useRef<number[]>([]);
  const held = useRef<number | null>(null);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  const spawn = useCallback(
    (el: HTMLElement, cx?: number, cy?: number) => {
      const rect = el.getBoundingClientRect();
      const x = cx === undefined ? rect.width / 2 : cx - rect.left;
      const y = cy === undefined ? rect.height / 2 : cy - rect.top;
      const r = Math.max(Math.hypot(x, y), Math.hypot(rect.width - x, y), Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y));
      const id = (seq.current += 1);
      born.current.set(id, performance.now());
      setDrops((d) => [...d.slice(-(max - 1)), { id, x, y, r, released: false }]);
      return id;
    },
    [max],
  );

  const release = useCallback((id: number | null) => {
    if (id === null) return;
    const wait = Math.max(0, MIN_VISIBLE - (performance.now() - (born.current.get(id) ?? 0)));
    timers.current.push(
      window.setTimeout(() => setDrops((d) => d.map((x) => (x.id === id ? { ...x, released: true } : x))), wait),
      window.setTimeout(() => {
        born.current.delete(id);
        setDrops((d) => d.filter((x) => x.id !== id));
      }, wait + FADE),
    );
  }, []);

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      release(held.current);
      held.current = spawn(e.currentTarget, e.clientX, e.clientY);
    },
    onPointerUp: () => {
      release(held.current);
      held.current = null;
    },
    onPointerLeave: () => {
      release(held.current);
      held.current = null;
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (disabled || e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
      release(held.current);
      held.current = spawn(e.currentTarget);
    },
    onKeyUp: () => {
      release(held.current);
      held.current = null;
    },
  };
  return { bind, drops };
}

/** The drops themselves. Put inside a `relative overflow-hidden` element, before its content. */
export function InkDrops({ drops, color = "currentColor" }: { drops: Drop[]; color?: string }) {
  const reduced = usePrefersReducedMotion();
  const id = `drop-${useId().replace(/:/g, "")}`;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
      {!reduced ? (
        <svg width="0" height="0" className="absolute">
          <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={3} seed={11} />
            <feDisplacementMap in="SourceGraphic" scale={14} />
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </svg>
      ) : null}
      {drops.map((d) =>
        reduced ? (
          <span key={d.id} className="absolute inset-0 transition-opacity" style={{ background: color, opacity: d.released ? 0 : 0.14 }} />
        ) : (
          <motion.span
            key={d.id}
            className="absolute block rounded-full"
            style={{ left: d.x - d.r, top: d.y - d.r, width: d.r * 2, height: d.r * 2, background: color, filter: `url(#${id})` }}
            initial={{ scale: 0, opacity: 0.32 }}
            animate={{ scale: 1.08, opacity: d.released ? 0 : 0.26 }}
            transition={{ scale: { duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }, opacity: { duration: d.released ? FADE / 1000 : 0.1 } }}
          />
        ),
      )}
    </span>
  );
}

export interface InkRippleButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Drop colour; defaults to the label colour. */
  ink?: string;
  asChild?: boolean;
  children?: ReactNode;
}

/** A Button that leaves an ink drop where it is pressed. Same variants and sizes as Button. */
export function InkRippleButton({ className, variant, size, ink, asChild = false, disabled, children, type, ...props }: InkRippleButtonProps) {
  const { bind, drops } = useInkRipple({ disabled: !!disabled });
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      disabled={disabled}
      className={cn(buttonVariants({ variant, size }), "relative isolate overflow-hidden [-webkit-tap-highlight-color:transparent]", className)}
      {...bind}
      {...props}
    >
      <InkDrops drops={drops} color={ink} />
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
}
