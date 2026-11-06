"use client";
// Adapted from 21st.dev @dqnamo/scramble-text (id 16620): text masked with cipher glyphs that
// resolve left to right, grapheme-aware, with a live region carrying the real value. Varada uses
// it for the FHE tally reveal: ballots stay sealed until the epoch closes, then the result decrypts.
// Glyphs are softer (dots, ticks and ledger marks rather than hacker noise) and it waits until it
// is on screen. Reduced motion shows the value at once.
import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

const GLYPHS = "·:;+×÷=≈~*#%°¦‡§";
const MAX_STEPS = 40;

function segments(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** Deterministic glyph for SSR and the first paint. */
function sealedGlyph(seg: string, i: number) {
  let h = i + 7;
  for (const c of seg) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 2147483647;
  return GLYPHS[h % GLYPHS.length]!;
}

function scramble(segs: string[], revealed: number, random: boolean) {
  return segs
    .map((s, i) => (s.trim() === "" || i < revealed ? s : random ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)]! : sealedGlyph(s, i)))
    .join("");
}

export interface DecryptTextProps {
  children: string;
  /** Milliseconds between steps. */
  intervalMs?: number;
  /** Keep it sealed (shows glyphs only) until this is true, e.g. until the epoch has closed. */
  sealed?: boolean;
  /** Start when on screen (default) or straight away. */
  trigger?: "inView" | "mount";
  className?: string;
}

/**
 * A value that decrypts in place. Assistive tech hears only the final value, once, through a
 * polite live region; while `sealed` it hears "Sealed".
 */
export function DecryptText({ children, intervalMs = 40, sealed = false, trigger = "inView", className }: DecryptTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(() => scramble(segments(children), 0, false));
  const go = !sealed && (trigger === "mount" || inView);

  useEffect(() => {
    const segs = segments(children);
    if (sealed) {
      setShown(scramble(segs, 0, false));
      return;
    }
    if (reduced || intervalMs <= 0) {
      setShown(children);
      return;
    }
    if (!go) return;
    let revealed = 0;
    const step = Math.max(1, Math.ceil(segs.length / MAX_STEPS));
    setShown(scramble(segs, 0, true));
    const t = window.setInterval(() => {
      revealed = Math.min(segs.length, revealed + step);
      setShown(scramble(segs, revealed, true));
      if (revealed >= segs.length) window.clearInterval(t);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [children, intervalMs, sealed, reduced, go]);

  return (
    <span ref={ref} data-slot="decrypt-text" data-sealed={sealed || undefined} className={cn("inline-block", className)}>
      <span aria-hidden="true">{shown}</span>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {sealed ? "Sealed" : children}
      </span>
    </span>
  );
}
