// Adapted from 21st.dev @diceui/status (id 25395): pill with an indicator dot and a label, tones per
// state. Session maths written for Varada (America/New_York through Intl, so DST is handled).
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * US equity session for Ondo tokenized stocks and ETFs. Ondo prices track the US market, so outside
 * regular hours (9:30 to 16:00 ET, Monday to Friday, not on exchange holidays) quotes go stale, and
 * Ondo can pause a single token. Everything is computed from a `now` prop, so the app decides how
 * often to tick and server and client render the same thing.
 */

export type MarketSession = "open" | "pre" | "after" | "closed" | "paused";

export interface MarketSessionInfo {
  session: MarketSession;
  /** The next open (or close, while open). Null while paused: Ondo gives no resume time. */
  next: Date | null;
  /** What happens at `next`. */
  nextEvent: "opens" | "closes" | null;
  /** True when the day in New York is a weekday that is not a holiday. */
  tradingDay: boolean;
}

export interface MarketCalendar {
  /** Full-day closures as New York dates, `YYYY-MM-DD`. */
  holidays?: readonly string[];
  /** Days the regular session ends at 13:00 ET (day after Thanksgiving, Christmas Eve…), `YYYY-MM-DD`. */
  earlyCloses?: readonly string[];
}

export interface MarketSessionOptions extends MarketCalendar {
  /** Ondo has paused this token: overrides the clock. */
  paused?: boolean;
}

const NY = "America/New_York";
const PRE_OPEN = 4 * 60;
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;
const AFTER_CLOSE = 20 * 60;

let nyFormat: Intl.DateTimeFormat | undefined;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in New York. */
export function newYorkParts(date: Date): ZonedParts {
  nyFormat ??= new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of nyFormat.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAY[p.weekday ?? "Sun"] ?? 0,
    // Some engines print midnight as 24 even with h23.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** The instant at a New York wall-clock time (minutes after midnight) on a New York date. */
export function newYorkInstant(year: number, month: number, day: number, minutes: number): Date {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  // Offset of New York from UTC near that instant; corrected once more for DST edges.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = newYorkParts(new Date(guess));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wall - seen;
  }
  return new Date(guess);
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function isTradingDay(y: number, m: number, d: number, weekday: number, holidays: readonly string[]): boolean {
  return weekday !== 0 && weekday !== 6 && !holidays.includes(ymd(y, m, d));
}

/** The next regular-session open strictly after `from` (a New York date, searching up to three weeks). */
function nextOpen(p: ZonedParts, minutes: number, holidays: readonly string[]): Date | null {
  for (let k = 0; k < 21; k++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + k));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!isTradingDay(y, m, d, day.getUTCDay(), holidays)) continue;
    if (k === 0 && minutes >= OPEN) continue;
    return newYorkInstant(y, m, d, OPEN);
  }
  return null;
}

/**
 * Where the US market is at `now`: pre-market 4:00–9:30, open 9:30–16:00 (13:00 on early-close days),
 * after-hours to 20:00, closed overnight, at weekends and on holidays. `paused` wins over the clock.
 */
export function usMarketSession(now: Date, options: MarketSessionOptions = {}): MarketSessionInfo {
  const holidays = options.holidays ?? [];
  const p = newYorkParts(now);
  const minutes = p.hour * 60 + p.minute;
  const tradingDay = isTradingDay(p.year, p.month, p.day, p.weekday, holidays);
  if (options.paused) return { session: "paused", next: null, nextEvent: null, tradingDay };

  const close = options.earlyCloses?.includes(ymd(p.year, p.month, p.day)) ? EARLY_CLOSE : CLOSE;
  if (tradingDay && minutes >= OPEN && minutes < close) {
    return { session: "open", next: newYorkInstant(p.year, p.month, p.day, close), nextEvent: "closes", tradingDay };
  }
  const next = nextOpen(p, minutes, holidays);
  let session: MarketSession = "closed";
  if (tradingDay && minutes >= PRE_OPEN && minutes < OPEN) session = "pre";
  else if (tradingDay && minutes >= close && minutes < AFTER_CLOSE) session = "after";
  return { session, next, nextEvent: next ? "opens" : null, tradingDay };
}

/** True when Ondo prices can be stale: anything but the regular session. */
export function isPriceStale(session: MarketSession): boolean {
  return session !== "open";
}

/** "2h 14m", "3d 4h", "45m", "under a minute". */
export function formatTimeUntil(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "Mon 9:30 ET" for the next open or close. */
export function formatNewYorkTime(date: Date, withDay = true): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" }).format(date);
  if (!withDay) return `${time} ET`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(date);
  return `${day} ${time} ET`;
}

export const MARKET_SESSION_LABEL: Record<MarketSession, string> = {
  open: "Market open",
  pre: "Pre-market",
  after: "After-hours",
  closed: "Market closed",
  paused: "Paused by Ondo",
};

const TONE: Record<MarketSession, { pill: string; dot: string }> = {
  open: { pill: "border-sage/25 bg-sage-tint text-sage-ink", dot: "bg-sage" },
  pre: { pill: "border-ochre/30 bg-ochre-tint text-ochre-ink", dot: "bg-ochre" },
  after: { pill: "border-ochre/30 bg-ochre-tint text-ochre-ink", dot: "bg-ochre" },
  closed: { pill: "border-line-strong bg-sand text-ink-soft", dot: "bg-ink-muted" },
  paused: { pill: "border-terracotta/30 bg-terracotta-tint text-terracotta-strong", dot: "bg-terracotta" },
};

export interface MarketStatusProps extends Omit<ComponentProps<"span">, "children"> {
  now: Date;
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** Ondo has paused this token. */
  paused?: boolean;
  /** Use a session computed elsewhere (e.g. once for a whole list) instead of recomputing. */
  info?: MarketSessionInfo;
  /** Show "opens in 2h 14m" after the label (default true). */
  showCountdown?: boolean;
  size?: "sm" | "md";
}

/** Session pill: dot, label and the time to the next open or close. */
export function MarketStatus({
  now,
  holidays,
  earlyCloses,
  paused,
  info,
  showCountdown = true,
  size = "md",
  className,
  ...props
}: MarketStatusProps) {
  const base = info ?? usMarketSession(now, { holidays, earlyCloses });
  const s: MarketSessionInfo = paused ? { ...base, session: "paused", next: null, nextEvent: null } : base;
  const tone = TONE[s.session];
  const until = s.next ? formatTimeUntil(s.next.getTime() - now.getTime()) : null;
  const at = s.next ? formatNewYorkTime(s.next, s.next.getTime() - now.getTime() > 20 * 3_600_000) : null;
  return (
    <span
      data-slot="market-status"
      data-session={s.session}
      title={at && s.nextEvent ? `${s.nextEvent === "opens" ? "Opens" : "Closes"} ${at}` : undefined}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-[13px]",
        tone.pill,
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn("relative flex size-2 shrink-0 rounded-full", tone.dot)}>
        {s.session === "open" ? <span className={cn("absolute inset-0 rounded-full motion-safe:animate-ping", tone.dot)} /> : null}
      </span>
      <span>{MARKET_SESSION_LABEL[s.session]}</span>
      {showCountdown && until && s.next ? (
        <span className="font-normal">
          {" · "}
          {s.nextEvent === "opens" ? "opens in " : "closes in "}
          <time dateTime={s.next.toISOString()} className="num">
            {until}
          </time>
        </span>
      ) : null}
    </span>
  );
}
