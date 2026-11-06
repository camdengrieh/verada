"use client";
// Adapted from 21st.dev @manuarora700/flip-words (id 1137): a word in a sentence that swaps on a
// timer, letters arriving from a blur on a spring while the old word drifts off. Varada version:
// the outgoing word lifts away like a wet stroke, a brush underline repaints under each new word,
// it pauses while hovered or focused, and it stands still (first word) under reduced motion.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

export interface FlipWordsProps {
  words: string[];
  /** Milliseconds each word stays. */
  interval?: number;
  /** Underline colour; any CSS colour or token. */
  stroke?: string;
  className?: string;
}

/**
 * Inline cycling word, e.g. "Every trade funds <FlipWords words={["clean water", "wildlife", ...]} />".
 * Screen readers get the whole list once ("clean water, wildlife and more"), not every change.
 */
export function FlipWords({ words, interval = 2600, stroke = "var(--ochre)", className }: FlipWordsProps) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduced || paused || words.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % words.length), interval);
    return () => window.clearTimeout(t);
  }, [index, reduced, paused, interval, words.length]);

  const spoken = words.length > 2 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words.join(" and ");
  const word = words[index] ?? "";

  return (
    <span
      className={cn("relative inline-block align-bottom", className)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true" className="relative inline-block">
        {reduced ? (
          <span className="relative z-10">{word}</span>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={word}
              className="relative z-10 inline-block whitespace-nowrap"
              exit={{ opacity: 0, y: "-0.6em", x: "0.3em", filter: "blur(6px)", scale: 1.15, transition: { duration: 0.35 } }}
            >
              {Array.from(word).map((ch, i) => (
                <motion.span
                  key={i}
                  className="inline-block whitespace-pre"
                  initial={{ opacity: 0, y: "0.4em", filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ delay: i * 0.035, type: "spring", stiffness: 260, damping: 18 }}
                >
                  {ch}
                </motion.span>
              ))}
            </motion.span>
          </AnimatePresence>
        )}
        <svg aria-hidden="true" viewBox="0 0 120 12" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 -bottom-1 h-[0.35em] w-full overflow-visible">
          <motion.path
            key={word}
            d="M3 7 C 30 3, 70 10, 117 5"
            stroke={stroke}
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
            opacity={0.6}
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.5, delay: 0.15, ease: [0.3, 0.7, 0.2, 1] }}
          />
        </svg>
      </span>
    </span>
  );
}
