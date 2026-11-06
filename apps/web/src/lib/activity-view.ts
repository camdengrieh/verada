import type { ActivityItem as FeedRow } from "@varada/ui/components/data/activity-list";
import type { ActivityContext } from "./activity";
import { formatUsdc } from "./agents";
import { formatQuote, formatQuoteAsUsd, timeAgo, unitsToNumber } from "./format";
import type { ActivityItem } from "./indexer";

const short = (v: string) => (v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v);
const dollar = (s: string | undefined) => (s ? `$${s.replace(/^\$/, "")}` : "a coin");
const bigOf = (v: unknown): bigint | null =>
  typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t * 1000).toISOString());

/**
 * Feed row for a `live_donation` item: USDC the live vault sent to a cause's org, in a swap or by
 * `flush`. The event names no donor, so the row shows only the cause and the org. With a context
 * the cause id is replaced by the catalogue's name.
 */
export function liveDonationRow(item: ActivityItem, ctx?: ActivityContext): FeedRow | null {
  if (item.kind !== "live_donation") return null;
  const raw = item.data.amount;
  const amount = typeof raw === "string" || typeof raw === "bigint" ? formatUsdc(raw) : "0";
  const causeId = typeof item.data.causeId === "string" ? item.data.causeId : undefined;
  const name = ctx?.causeOf(causeId)?.name;
  const cause = name ?? (causeId ? short(causeId) : "cause");
  const org = typeof item.data.org === "string" ? short(item.data.org) : null;
  return {
    id: item.id,
    kind: "give",
    tag: "Live gift",
    title: `Donated to ${cause}`,
    meta: [org ? `org ${org}` : null, item.data.inSwap === true ? "in a swap" : "by flush"].filter(Boolean).join(" · "),
    amount: `$${amount}`,
    amountTone: "cause",
    time: ctx && item.timestamp !== undefined ? timeAgo(item.timestamp, ctx.nowSeconds) : undefined,
    dateTime: iso(item.timestamp),
  };
}

/** A weekly-pool payout to a cause. */
function donationRow(item: ActivityItem, ctx: ActivityContext): FeedRow | null {
  const amount = bigOf(item.data.amount);
  if (amount === null) return null;
  const cause = ctx.causeOf(typeof item.data.causeId === "string" ? item.data.causeId : undefined);
  return {
    id: item.id,
    kind: "give",
    title: `${dollar(ctx.symbolOf(item.token))} gave to ${cause ? cause.name : "a cause"}`,
    amount: `$${formatUsdc(amount)}`,
    amountTone: "cause",
    time: timeAgo(item.timestamp, ctx.nowSeconds),
    dateTime: iso(item.timestamp),
  };
}

/** A swap. The trader's address is public on chain but is left out of the row. */
function tradeRow(item: ActivityItem, ctx: ActivityContext): FeedRow | null {
  const side = item.data.side;
  if (side !== "buy" && side !== "sell") return null;
  const amount = bigOf(item.data.quoteAmount);
  const quoteAddress = typeof item.data.quote === "string" ? item.data.quote : undefined;
  const q = ctx.quoteOf(quoteAddress);
  const usd = ctx.usdOf?.(quoteAddress);
  const units = amount !== null && q ? unitsToNumber(amount, q.decimals) : null;
  return {
    id: item.id,
    kind: side,
    title: `${side === "buy" ? "Bought" : "Sold"} ${dollar(ctx.symbolOf(item.token))}`,
    amount: units !== null && q ? formatQuoteAsUsd(units, q.symbol, usd) : undefined,
    // The quote asset's own amount stays as the secondary line when the headline is dollars.
    ...(units !== null && q && usd?.priceUsd != null ? { meta: formatQuote(units, q.symbol) } : {}),
    amountTone: side === "buy" ? "gain" : "loss",
    time: timeAgo(item.timestamp, ctx.nowSeconds),
    dateTime: iso(item.timestamp),
  };
}

/**
 * Maps an indexer activity item to a feed row: trades and gives (weekly payouts and live-vault
 * donations). Other kinds give null. Without a context only live donations render, with the id short.
 */
export function activityRow(item: ActivityItem, ctx?: ActivityContext): FeedRow | null {
  if (item.kind === "live_donation") return liveDonationRow(item, ctx);
  if (!ctx) return null;
  if (item.kind === "trade") return tradeRow(item, ctx);
  if (item.kind === "donation") return donationRow(item, ctx);
  return null;
}
