// Adapted from 21st.dev @ddoemonn/wizard-steps (id 23576): the direction-aware panel crossfade, lifted out on its own.
"use client";

import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

export type StepDirection = 1 | -1;

const SPRING = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const EXIT_EASE = [0.4, 0, 1, 1] as const;

const slide: Variants = {
  enter: (d: StepDirection) => ({ opacity: 0, x: d * 28 }),
  center: { opacity: 1, x: 0 },
  exit: (d: StepDirection) => ({ opacity: 0, x: d * -28, transition: { duration: 0.14, ease: EXIT_EASE } }),
};
const still: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0 } },
};

export interface StepTransitionProps {
  /** Changes whenever the panel should transition (usually the step id). */
  stepKey: string;
  /** 1 moves forward (enters from the right), -1 moves back (enters from the left). */
  direction: StepDirection;
  children: ReactNode;
  className?: string;
  /** Classes for the moving panel itself. */
  panelClassName?: string;
}

/**
 * Slides the outgoing panel away and the incoming one in from the side it is travelling toward.
 * The exiting panel pops out of layout immediately, so the new one mounts (and can take focus)
 * straight away. Reduced motion swaps panels with no travel.
 */
export function StepTransition({ stepKey, direction, children, className, panelClassName }: StepTransitionProps) {
  const reduced = useReducedMotion();
  return (
    <div data-slot="step-transition" className={cn("relative overflow-hidden", className)}>
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.div
          key={stepKey}
          custom={direction}
          variants={reduced ? still : slide}
          initial="enter"
          animate="center"
          exit="exit"
          transition={reduced ? { duration: 0 } : SPRING}
          className={panelClassName}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
