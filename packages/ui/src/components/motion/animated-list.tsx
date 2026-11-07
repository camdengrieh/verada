"use client";
// Adapted from 21st.dev @dillionverma/animated-list (Magic UI, id 869) and
// @unlumen/unlumen-animated-list (id 38150): a live feed where new items pop in at the top on a
// spring and the rest make room. Varada version: it is controlled (you pass the items, newest
// first, as they arrive), new rows land like a dab of paint with a brief sage wash, the oldest
// drop off past `max`, it is a polite log for screen readers, and reduced motion just swaps rows.
import { AnimatePresence, motion } from "motion/react";
import { useRef, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@varada/ui/components/motion/marquee";
import { cn } from "@varada/ui/lib/utils";

export interface AnimatedListItem {
  id: string;
  content: ReactNode;
}

export interface AnimatedListProps {
  /** Newest first. Keep ids stable; a new id at the front animates in. */
  items: AnimatedListItem[];
  /** Rows kept on screen. */
  max?: number;
  /** Accessible name, e.g. "Live donations". */
  label: string;
  className?: string;
  itemClassName?: string;
}

export function AnimatedList({ items, max = 5, label, className, itemClassName }: AnimatedListProps) {
  const reduced = usePrefersReducedMotion();
  const shown = items.slice(0, max);
  // Rows present on first render are history, not news: no wash for them.
  const initial = useRef<Set<string> | null>(null);
  const history = (initial.current ??= new Set(items.map((i) => i.id)));
  return (
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label={label} data-slot="animated-list">
    <ul className={cn("flex flex-col gap-2.5", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((item) => (
          <motion.li
            key={item.id}
            layout={!reduced}
            initial={reduced ? false : { opacity: 0, scale: 0.85, y: -16, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            style={{ originY: 0 }}
            className={cn("relative", itemClassName)}
          >
            {!reduced && !history.has(item.id) ? (
              <motion.span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-2xl bg-sage-tint"
                initial={{ opacity: 0.9 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 1.4, ease: "easeOut" }}
              />
            ) : null}
            <div className="relative">{item.content}</div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
    </div>
  );
}
