"use client";
// Adapted from 21st.dev @dillionverma/orbiting-circles (Magic UI, id 1411): items travelling on
// circular paths around a centre, rings in either direction. Varada version: drawn rings are
// pencilled dashes on paper, items stay upright as they travel, every ring pauses while the pointer
// or keyboard focus is inside or the orbit is off screen, and reduced motion lays the items out
// evenly and keeps them still. Typical use: cause icons circling the mudra mark.
import { motion, useAnimationFrame, useInView, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { Children, createContext, useContext, useRef, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

const OrbitContext = createContext<{ running: boolean }>({ running: false });

export interface OrbitProps {
  /** Side of the square stage, in px. Rings should fit inside half of it. */
  size?: number;
  /** What sits in the middle, e.g. <LogoMark />. */
  center?: ReactNode;
  /** Name for the group of orbiting items. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function Orbit({ size = 320, center, label, children, className }: OrbitProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(ref, { amount: 0.1 });
  const [held, setHeld] = useState(false);
  const running = !reduced && inView && !held;
  return (
    <OrbitContext.Provider value={{ running }}>
      <div
        ref={ref}
        role="group"
        aria-label={label}
        data-slot="orbit"
        data-running={running || undefined}
        className={cn("relative mx-auto max-w-full", className)}
        style={{ width: size, height: size }}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
        }}
      >
        {center ? <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">{center}</div> : null}
        {children}
      </div>
    </OrbitContext.Provider>
  );
}

export interface OrbitRingProps {
  radius: number;
  /** Seconds per lap. */
  duration?: number;
  reverse?: boolean;
  /** Draw the ring itself. */
  path?: boolean;
  /** Starting rotation in degrees. */
  offset?: number;
  children: ReactNode;
}

function Satellite({ turn, angle, radius, children }: { turn: MotionValue<number>; angle: number; radius: number; children: ReactNode }) {
  const upright = useTransform(turn, (t) => -t);
  return (
    <li
      className="absolute left-1/2 top-1/2 size-0"
      style={{ transform: `rotate(${angle}deg) translateX(${radius}px) rotate(${-angle}deg)` }}
    >
      <motion.div className="w-max -translate-x-1/2 -translate-y-1/2" style={{ rotate: upright }}>
        {children}
      </motion.div>
    </li>
  );
}

/** One ring of items, spaced evenly. */
export function OrbitRing({ radius, duration = 30, reverse = false, path = true, offset = 0, children }: OrbitRingProps) {
  const { running } = useContext(OrbitContext);
  const turn = useMotionValue(offset);
  useAnimationFrame((_, delta) => {
    if (!running) return;
    turn.set(turn.get() + ((reverse ? -360 : 360) * Math.min(delta, 64)) / 1000 / duration);
  });
  const items = Children.toArray(children);
  return (
    <>
      {path ? (
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
          <circle cx="50%" cy="50%" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="3 7" strokeLinecap="round" />
        </svg>
      ) : null}
      <motion.ul className="absolute inset-0" style={{ rotate: turn }}>
        {items.map((child, i) => (
          <Satellite key={i} turn={turn} angle={(360 / items.length) * i} radius={radius}>
            {child}
          </Satellite>
        ))}
      </motion.ul>
    </>
  );
}
