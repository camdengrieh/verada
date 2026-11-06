import type { Hex } from "viem";

/** Known accounts the holder views name instead of ranking as people. */
export type HolderLabel = "pool" | "creator" | "burn" | "vault";

export const DEAD = "0x000000000000000000000000000000000000dead" as const;

export interface HolderRow {
  account: Hex;
  balance: bigint;
  firstSeenAt: bigint;
}

export interface TradeRow {
  id: string;
  token: Hex;
  side: string;
  trader: Hex;
  sender: Hex;
  tokenAmount: bigint;
  quote: Hex;
  quoteAmount: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  feePips: number;
  blockNumber: bigint;
  logIndex: number;
  timestamp: bigint;
  txHash: Hex;
}

export interface TradeHourRow {
  hour: bigint;
  buys: number;
  sells: number;
  buyQuote: bigint;
  sellQuote: bigint;
  buyToken: bigint;
  sellToken: bigint;
  openTick: number;
  highTick: number;
  lowTick: number;
  closeTick: number;
  closeSqrtPriceX96: bigint;
}

export interface MarketInfo {
  quote: Hex;
  quoteDecimals: number | null;
  tokenIsCurrency0: boolean;
}

/**
 * Holdings bands by share of supply, largest first. A balance falls in the first band whose
 * floor (`supply / divisor`) it reaches; the last band has no floor.
 */
export const HOLDER_BUCKETS = [
  { label: "1% or more", divisor: 100n },
  { label: "0.1% to 1%", divisor: 1_000n },
  { label: "0.01% to 0.1%", divisor: 10_000n },
  { label: "Under 0.01%", divisor: null },
] as const;

export interface BucketRow {
  label: string;
  holders: number;
  balance: bigint;
}

export interface MarketRepo {
  /** Quote side of the pool; null before the token's first trade. */
  market(token: Hex): Promise<MarketInfo | null>;
  /** Newest first, keyset by (timestamp, id). */
  trades(token: Hex, q: { before?: { t: bigint; k: string }; side?: "buy" | "sell"; limit: number }): Promise<TradeRow[]>;
  holderStat(token: Hex): Promise<{ holders: number; supply: bigint; transfers: number } | null>;
  /** Largest balances first, nonzero only. */
  topHolders(token: Hex, limit: number, exclude: Hex[]): Promise<HolderRow[]>;
  /** Holders per band of {@link HOLDER_BUCKETS}, excluding `exclude`. */
  buckets(token: Hex, supply: bigint, exclude: Hex[]): Promise<BucketRow[]>;
  balancesOf(token: Hex, accounts: Hex[]): Promise<{ account: Hex; balance: bigint }[]>;
  newHolders(token: Hex, since: bigint): Promise<number>;
  holderDays(token: Hex, since: bigint): Promise<{ day: bigint; holders: number }[]>;
  hours(token: Hex, since: bigint): Promise<TradeHourRow[]>;
  tradeStat(token: Hex): Promise<{
    trades: number;
    buys: number;
    sells: number;
    volumeQuote: bigint;
    volumeToken: bigint;
    lastSqrtPriceX96: bigint;
    lastTick: number;
    lastTradeAt: bigint;
  } | null>;
  /** Accounts to label for `token`: its creator and the platform contracts. */
  labels(token: Hex): Promise<Map<string, HolderLabel>>;
}

/** Percent of supply to four decimals (0 when supply is 0). */
export function shareOf(balance: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Number((balance * 1_000_000n) / supply) / 10_000;
}

const Q96 = 2n ** 96n;

/**
 * Quote per whole token from a pool sqrt price (the token has 18 decimals). Float precision is
 * enough for display; exact amounts stay in the raw fields.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quoteDecimals: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const r = Number(sqrtPriceX96) / Number(Q96);
  const raw = r * r; // currency1 per currency0, raw units
  const perRaw = tokenIsCurrency0 ? raw : 1 / raw; // quote raw per token raw
  return perRaw * 10 ** (18 - quoteDecimals);
}

export function toTradeView(r: TradeRow, m: MarketInfo | null) {
  return {
    id: r.id,
    side: r.side as "buy" | "sell",
    trader: r.trader,
    sender: r.sender,
    tokenAmount: r.tokenAmount,
    quote: r.quote,
    quoteAmount: r.quoteAmount,
    quoteDecimals: m?.quoteDecimals ?? null,
    price: m && m.quoteDecimals !== null ? priceFromSqrt(r.sqrtPriceX96, m.tokenIsCurrency0, m.quoteDecimals) : null,
    feePips: r.feePips,
    blockNumber: r.blockNumber,
    timestamp: r.timestamp,
    txHash: r.txHash,
  };
}

/** Ranked holder rows with share of supply and labels for known accounts. */
export function toHolderViews(rows: HolderRow[], supply: bigint, labels: Map<string, HolderLabel>) {
  return rows.map((r, i) => ({
    rank: i + 1,
    account: r.account,
    balance: r.balance,
    share: shareOf(r.balance, supply),
    label: labels.get(r.account.toLowerCase()) ?? null,
    firstSeenAt: r.firstSeenAt,
  }));
}

/** One point per UTC day from `from` to `to`, carrying the last known count over quiet days. */
export function fillDays(rows: { day: bigint; holders: number }[], from: bigint, to: bigint, before = 0) {
  const DAY = 86_400n;
  const by = new Map(rows.map((r) => [r.day, r.holders]));
  const out: { day: bigint; holders: number }[] = [];
  let last = before;
  for (let d = from - (from % DAY); d <= to; d += DAY) {
    last = by.get(d) ?? last;
    out.push({ day: d, holders: last });
  }
  return out;
}

/** Totals over a window of hourly rows, with the share of trades that were buys. */
export function windowOf(rows: TradeHourRow[]) {
  let buys = 0;
  let sells = 0;
  let buyQuote = 0n;
  let sellQuote = 0n;
  for (const r of rows) {
    buys += r.buys;
    sells += r.sells;
    buyQuote += r.buyQuote;
    sellQuote += r.sellQuote;
  }
  const trades = buys + sells;
  return {
    trades,
    buys,
    sells,
    buyQuote,
    sellQuote,
    volumeQuote: buyQuote + sellQuote,
    buyShare: trades === 0 ? null : Math.round((buys / trades) * 1000) / 10,
  };
}
