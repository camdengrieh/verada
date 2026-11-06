"use client";
// Adapted from 21st.dev @tom_ui/tilt-card (id 12244): a perspective tilt that follows the pointer
// with a soft light on top. Varada version: driven by motion values and springs (no re-render per
// move), the light is a warm paper sheen, the shadow slides the opposite way as if the sheet is
// lifted off the desk, touch skips it, and reduced motion leaves a flat card.
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "motion/react";
import type { ComponentProps, PointerEvent } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

export interface TiltCardProps extends Omit<ComponentProps<"div">, "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"> {
  /** Largest tilt in degrees. */
  max?: number;
  /** Paper sheen under the pointer. */
  sheen?: boolean;
}

const SPRING = { stiffness: 220, damping: 20, mass: 0.6 };

/** A card you can pick up: it tips toward the pointer. Decoration only; content stays put for reading. */
export function TiltCard({ max = 8, sheen = true, className, children, onPointerMove, onPointerLeave, style, ...props }: TiltCardProps) {
  const reduced = usePrefersReducedMotion();
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const lifted = useMotionValue(0);
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), SPRING);
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), SPRING);
  const lift = useSpring(lifted, SPRING);
  const scale = useTransform(lift, [0, 1], [1, 1.015]);
  const sx = useTransform(px, [0, 1], [14, -14]);
  const sy = useTransform(py, [0, 1], [26, 10]);
  const shadow = useMotionTemplate`${sx}px ${sy}px 40px -24px color-mix(in oklab, var(--ink) 45%, transparent)`;
  const gx = useTransform(px, (v) => `${v * 100}%`);
  const gy = useTransform(py, (v) => `${v * 100}%`);
  const light = useMotionTemplate`radial-gradient(420px circle at ${gx} ${gy}, color-mix(in oklab, var(--paper-card) 75%, transparent), transparent 55%)`;
  const lightOpacity = useTransform(lift, [0, 1], [0, 0.9]);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e);
    if (reduced || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
    lifted.set(1);
  };
  const leave = (e: PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(e);
    px.set(0.5);
    py.set(0.5);
    lifted.set(0);
  };

  if (reduced) {
    return (
      <div data-slot="tilt-card" className={cn("relative", className)} style={style} {...props}>
        {children}
      </div>
    );
  }

  return (
    <div data-slot="tilt-card" className="[perspective:1000px]">
      <motion.div
        className={cn("relative isolate will-change-transform [transform-style:preserve-3d]", className)}
        style={{ ...style, rotateX: rx, rotateY: ry, scale, boxShadow: shadow }}
        onPointerMove={move}
        onPointerLeave={leave}
        {...props}
      >
        {children}
        {sheen ? (
          <motion.span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] mix-blend-soft-light" style={{ background: light, opacity: lightOpacity }} />
        ) : null}
      </motion.div>
    </div>
  );
}
