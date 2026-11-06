import type { ActivityFeedItem } from "@varada/ui/components/varada/activity-feed";
import type { ActivityTickerItem } from "@varada/ui/components/varada/activity-ticker";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";
import type { ActivityItem } from "./indexer";
import { formatQuote, formatUsdc, timeAgo, unitsToNumber } from "./format";

/** Turns indexer activity into the library's ticker and feed rows. Pure; the page supplies the lookups. */
export interface ActivityContext {
  /** Symbol of a token, if known. */
  symbolOf(token: string | undefined): string | undefined;
  /** Symbol and decimals of a quote asset address. */
  quoteOf(address: string | undefined): { symbol: string; decimals: number } | undefined;
  /** Name and category of the cause behind a cause id. */
  causeOf(causeId: string | undefined): { name: string; cause: CauseName } | undefined;
  nowSeconds: number;
}

const dollar = (s: string | undefined) => (s ? `$${s.replace(/^\$/, "")}` : "a coin");
const bigOf = (v: unknown): bigint | null =>
  typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isInteger(v) && v >= 0 ? BigInt(v) : null;

export function toTickerItem(a: ActivityItem, ctx: ActivityContext): ActivityTickerItem | null {
  const symbol = dollar(ctx.symbolOf(a.token));
  switch (a.kind) {
    case "trade": {
      const side = a.data.side === "sell" ? "SELL" : a.data.side === "buy" ? "BUY" : null;
      const amount = bigOf(a.data.quoteAmount);
      const q = ctx.quoteOf(typeof a.data.quote === "string" ? a.data.quote : undefined);
      if (!side || amount === null || !q) return null;
      return { id: a.id, kind: side, symbol, text: formatQuote(unitsToNumber(amount, q.decimals), q.symbol) };
    }
    case "donation": {
      const amount = bigOf(a.data.amount);
      if (amount === null) return null;
      const cause = ctx.causeOf(typeof a.data.causeId === "string" ? a.data.causeId : undefined);
      return { id: a.id, kind: "GIVE", symbol, text: `${formatUsdc(amount)}${cause ? ` to ${cause.name}` : " to a cause"}` };
    }
    case "launch":
      return { id: a.id, kind: "NEW", symbol, text: "just launched" };
    case "vote":
      return { id: a.id, kind: "VOTE", symbol, text: "ballot cast" };
    default:
      return null;
  }
}

/** Donations as "Live giving" rows. */
export function toFeedItem(a: ActivityItem, ctx: ActivityContext, fresh = false): ActivityFeedItem | null {
  if (a.kind !== "donation") return null;
  const amount = bigOf(a.data.amount);
  if (amount === null) return null;
  const cause = ctx.causeOf(typeof a.data.causeId === "string" ? a.data.causeId : undefined);
  return {
    id: a.id,
    symbol: dollar(ctx.symbolOf(a.token)),
    text: cause ? `gave to ${cause.name}` : "gave to a cause",
    ago: timeAgo(a.timestamp, ctx.nowSeconds),
    amount: formatUsdc(amount),
    cause: cause?.cause ?? "other",
    fresh,
  };
}

/** USDC base units of a donation event, or null. */
export function donationAmount(a: ActivityItem): bigint | null {
  return a.kind === "donation" ? bigOf(a.data.amount) : null;
}

/** Keeps the newest `max` items, newest first, without duplicates. */
export function mergeActivity(prev: readonly ActivityItem[], incoming: readonly ActivityItem[], max = 40): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const i of [...incoming, ...prev]) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, max);
}
