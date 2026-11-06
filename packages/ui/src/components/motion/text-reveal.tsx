"use client";
// Adapted from 21st.dev @kuratlielia/text-reveal (id 35037: each word rises out of a soft blur) and
// @ddoemonn/text-reveal (id 23571: word or character split, optionally when scrolled into view).
// Restyled as ink soaking into paper: words arrive from a warm blur with a slight lift, and the
// full sentence is always in the accessibility tree as plain text.
import { motion, useInView, type Variants } from "motion/react";
import { createElement, Fragment, useRef, type ElementType } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface TextRevealProps {
  text: string;
  /** Element to render, e.g. "h2" or "p". */
  as?: ElementType;
  /** Split into words (default) or characters. */
  by?: "word" | "char";
  /** Start on mount, or when it first scrolls into view (default). */
  trigger?: "mount" | "inView";
  /** Seconds before the first word, and between words. */
  delay?: number;
  stagger?: number;
  className?: string;
}

const piece: Variants = {
  hidden: { opacity: 0, y: "0.35em", filter: "blur(8px)" },
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.55, ease: [0.2, 0.7, 0.2, 1] } },
};

/** A headline or sentence that inks itself in, word by word. Static text under reduced motion. */
export function TextReveal({ text, as = "p", by = "word", trigger = "inView", delay = 0, stagger, className }: TextRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();
  const inView = useInView(ref, { once: true, amount: 0.4 });
  if (reduced) return createElement(as, { className }, text);

  const go = trigger === "mount" || inView;
  const words = text.split(" ");
  const step = stagger ?? (by === "char" ? 0.025 : 0.07);
  return createElement(
    as,
    { ref, className: cn("text-balance", className) },
    <span className="sr-only">{text}</span>,
    <motion.span
      aria-hidden="true"
      initial="hidden"
      animate={go ? "shown" : "hidden"}
      variants={{ hidden: {}, shown: { transition: { staggerChildren: step, delayChildren: delay } } }}
    >
      {words.map((word, wi) => (
        <Fragment key={wi}>
          <span className="inline-block whitespace-nowrap">
            {by === "word" ? (
              <motion.span variants={piece} className="inline-block">
                {word}
              </motion.span>
            ) : (
              Array.from(word).map((ch, ci) => (
                <motion.span key={ci} variants={piece} className="inline-block">
                  {ch}
                </motion.span>
              ))
            )}
          </span>
          {wi < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </motion.span>,
  );
}
