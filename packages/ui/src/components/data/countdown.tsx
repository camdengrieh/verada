// Written for Varada (21st.dev countdowns found, e.g. @anubra266/countdown-timer id 6067, need @ark-ui; segment layout follows it).
"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Milliseconds left, never negative. */
  total: number;
}

/** Split a millisecond span into d / h / m / s (clamped at zero). */
export function countdownParts(ms: number): CountdownParts {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    total,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Sentence for screen readers, at minute precision until the last minute. */
export function countdownSentence(p: CountdownParts): string {
  if (p.total <= 0) return "Time is up";
  if (p.days === 0 && p.hours === 0 && p.minutes === 0) return `${plural(p.seconds, "second")} remaining`;
  const bits = [p.days ? plural(p.days, "day") : null, p.hours ? plural(p.hours, "hour") : null, plural(p.minutes, "minute")];
  return `${bits.filter(Boolean).join(", ")} remaining`;
}

/** Compact mono form: "2d 04h 09m 07s" (days dropped when zero). */
export function formatCountdown(p: CountdownParts): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const core = `${two(p.hours)}h ${two(p.minutes)}m ${two(p.seconds)}s`;
  return p.days ? `${p.days}d ${core}` : core;
}

export interface CountdownProps {
  /** Target time: epoch milliseconds or a Date. */
  to: number | Date;
  /** Called once when the countdown reaches zero. */
  onDone?: () => void;
  /** Visible heading for the timer, e.g. "Epoch 12 closes in". */
  label?: string;
  /** `boxes` for hero placements, `inline` for rows and cards. */
  variant?: "boxes" | "inline";
  /** Shown when the time is up. */
  doneText?: string;
  className?: string;
}

/**
 * Live countdown to a timestamp. It renders placeholders on the server (static export) and starts
 * ticking on mount. The digits are hidden from screen readers; a polite live region speaks the
 * time left at minute precision (in the final minute only at the 60s, 30s and 10s marks), and once
 * when time is up.
 */
export function Countdown({ to, onDone, label, variant = "boxes", doneText = "Closed", className }: CountdownProps) {
  const target = typeof to === "number" ? to : to.getTime();
  const [now, setNow] = useState<number | null>(null);
  const done = useRef(false);
  const doneCb = useRef(onDone);
  useEffect(() => {
    doneCb.current = onDone;
  });

  useEffect(() => {
    done.current = false;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  const parts = now === null ? null : countdownParts(target - now);
  const finished = parts !== null && parts.total <= 0;

  useEffect(() => {
    if (finished && !done.current) {
      done.current = true;
      doneCb.current?.();
    }
  }, [finished]);

  // Coarse announcements: change the live text only at minute boundaries (and 30s / 10s at the end).
  let spoken = "";
  if (parts) {
    if (parts.total <= 0) spoken = countdownSentence(parts);
    else if (parts.total < 60_000) {
      const s = parts.seconds > 30 ? 60 : parts.seconds > 10 ? 30 : 10;
      spoken = `Less than ${s} seconds remaining`;
    } else spoken = countdownSentence({ ...parts, seconds: 0 });
  }

  const units: [string, string, number | undefined][] = [
    ["d", "days", parts?.days],
    ["h", "hours", parts?.hours],
    ["m", "minutes", parts?.minutes],
    ["s", "seconds", parts?.seconds],
  ];

  return (
    <div data-slot="countdown" role="group" aria-label={label ?? "Countdown"} className={cn("flex flex-col gap-2", className)}>
      {label ? <span className="kicker">{label}</span> : null}
      {finished ? (
        <span className="num text-lg font-semibold text-ink">{doneText}</span>
      ) : variant === "inline" ? (
        <span aria-hidden="true" className="num text-lg font-semibold text-ink">
          {parts ? formatCountdown(parts) : "--h --m --s"}
        </span>
      ) : (
        <div aria-hidden="true" className="flex gap-2">
          {units.map(([short, long, n]) => (
            <div key={short} className="flex min-w-16 flex-col items-center rounded-xl border border-line bg-paper-card px-3 py-2">
              <span className="num text-3xl leading-none font-semibold text-ink">
                {n === undefined ? "--" : String(n).padStart(2, "0")}
              </span>
              <span className="mt-1 text-xs text-ink-muted">{long}</span>
            </div>
          ))}
        </div>
      )}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {spoken}
      </span>
    </div>
  );
}
