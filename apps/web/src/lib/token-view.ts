/** Small pure helpers for the token page's header: profile links and number formats. */
import { TOKEN_TEXT_KEYS } from "@varada/sdk";

export interface ProfileLink {
  key: "url" | "twitter" | "telegram" | "discord" | "github";
  label: string;
  /** What is shown next to the label ("@mooncat", "mooncat.example"). */
  text: string;
  /** Null when the record is not a safe link (shown as plain text). */
  href: string | null;
}

const HANDLE = /^@?([A-Za-z0-9_.-]{1,39})$/;

/** Only http(s) values become links. */
export function safeHref(value: string): string | null {
  return /^https?:\/\//i.test(value) ? value : null;
}

function shortUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return value;
  }
}

/**
 * The profile's social records as links. A record may be a full http(s) URL or a bare handle
 * (`mooncat`, `@mooncat`); handles are expanded for X, Telegram and GitHub, and Discord (an invite
 * or a name) is only linked when it is a URL.
 */
export function profileLinks(texts: Readonly<Record<string, string>>): ProfileLink[] {
  const out: ProfileLink[] = [];
  const add = (key: ProfileLink["key"], label: string, raw: string | undefined, expand?: (handle: string) => string) => {
    const v = raw?.trim();
    if (!v) return;
    const direct = safeHref(v);
    if (direct) return void out.push({ key, label, text: shortUrl(direct), href: direct });
    const h = HANDLE.exec(v);
    if (h && expand) return void out.push({ key, label, text: `@${h[1]}`, href: expand(h[1]!) });
    out.push({ key, label, text: v, href: null });
  };
  add("url", "Website", texts[TOKEN_TEXT_KEYS.url]);
  add("twitter", "X", texts[TOKEN_TEXT_KEYS.twitter], (h) => `https://x.com/${h}`);
  add("telegram", "Telegram", texts[TOKEN_TEXT_KEYS.telegram], (h) => `https://t.me/${h}`);
  add("discord", "Discord", texts[TOKEN_TEXT_KEYS.discord]);
  add("github", "GitHub", texts[TOKEN_TEXT_KEYS.github], (h) => `https://github.com/${h}`);
  return out;
}

/** "in 2d 4h", "in 35m": time until `at` (unix seconds) from `now` (ms), two units at most. Empty string once passed. */
export function untilText(at: number, nowMs: number): string {
  const s = Math.floor(at - nowMs / 1000);
  if (s <= 0) return "";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

/** Whole-number or compact currency text for dollar amounts. */
export function usdText(value: number, compact = false): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", ...(compact ? { notation: "compact", maximumFractionDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }).format(value);
}
