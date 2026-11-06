"use client";
// ScrollWordReveal is adapted from 21st.dev @motiondotdev/motion-scroll-word-reveal (id 24525,
// the official Motion example): each word darkens from a faint rest opacity as its slice of the
// scroll passes. Varada version: words go from pencil grey to ink, it can track a scrollable panel,
// the sentence is read once as plain text, and reduced motion shows it fully inked.
// ScrollReveal (a block that settles in like a sheet laid on the desk when scrolled into view) is
// written for Varada in the same vein.
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { createElement, Fragment, useRef, type ElementType, type ReactNode, type RefObject } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

const REST = 0.18;
const SPAN = 0.8;
const WINDOW = 0.22;

function Word({ progress, index, count, children }: { progress: MotionValue<number>; index: number; count: number; children: string }) {
  const start = count <= 1 ? 0 : (index / (count - 1)) * SPAN;
  const end = Math.min(1, start + WINDOW);
  const opacity = useTransform(progress, [start, end], [REST, 1], { clamp: true });
  return <motion.span style={{ opacity }}>{children}</motion.span>;
}

export interface ScrollWordRevealProps {
  text: string;
  as?: ElementType;
  /** Scrollable ancestor, when the text is in a panel rather than the page. */
  container?: RefObject<HTMLElement | null>;
  /** Scroll window over which the sentence inks in (motion `offset`). */
  offset?: [string, string];
  className?: string;
}

/** A sentence that inks in word by word as it scrolls through the viewport (or a panel). */
export function ScrollWordReveal({ text, as = "p", container, offset = ["start 0.9", "start 0.3"], className }: ScrollWordRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, container, offset: offset as never });
  const words = text.split(" ");
  if (reduced) return createElement(as, { ref, className }, text);
  return createElement(
    as,
    { ref, className: cn("text-balance", className) },
    <span key="sr" className="sr-only">
      {text}
    </span>,
    <span key="ink" aria-hidden="true">
      {words.map((w, i) => (
        <Fragment key={i}>
          <Word progress={scrollYProgress} index={i} count={words.length}>
            {w}
          </Word>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>,
  );
}

export interface ScrollRevealProps {
  children: ReactNode;
  /** Seconds before it starts, to stagger siblings. */
  delay?: number;
  className?: string;
}

/** A block that settles into place (rise, slight turn, sharpen) the first time it scrolls into view. */
export function ScrollReveal({ children, delay = 0, className }: ScrollRevealProps) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24, rotate: -0.6, filter: "blur(3px)" }}
      whileInView={{ opacity: 1, y: 0, rotate: 0, filter: "blur(0px)" }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ type: "spring", stiffness: 140, damping: 20, delay }}
    >
      {children}
    </motion.div>
  );
}
