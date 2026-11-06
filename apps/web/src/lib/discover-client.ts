import type { AppConfig } from "./config";
import { chainTokens } from "./chain-reads";
import type { DataDeps } from "./data";
import { IndexerClient, IndexerError, type Page, type TokenSummary } from "./indexer";

/**
 * Client for `GET /api/discover`: tokens with their market summary, one request per page (no
 * per-token calls). Falls back to the plain token list (`/api/tokens`, then the chain) with no
 * market data when the route is missing or the indexer is down.
 */

export const DISCOVER_SORTS = ["trending", "new", "raised", "holders", "change"] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export type DiscoverMode = { kind: "weekly" } | { kind: "live"; period: number; periodSeconds: number };

export interface DiscoverMarket {
  quote: string | null;
  quoteDecimals: number | null;
  /** Quote per whole token at the last trade. */
  price: number | null;
  /** Percent move since the first trade of the last 24 hours. */
  change24h: number | null;
  /** Base units of the quote asset. */
  volume24hQuote: bigint;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  tradesTotal: number;
  lastTradeAt: number | null;
  /** The pool's quote side, base units of the quote asset (buyers paid in minus sellers took out). */
  quoteInPool: bigint;
  holders: number | null;
  supply: bigint | null;
}

export interface DiscoverToken {
  address: string;
  name: string;
  symbol: string;
  label: string | null;
  logoRef: string | null;
  createdAt: number | null;
  feeBps: number | null;
  /** Cause focus as catalogue slugs (empty arrays: any). Null until indexed. */
  focus: { categories: string[]; regions: string[] } | null;
  /** USDC base units credited to causes. */
  raised: bigint;
  mode: DiscoverMode;
  /** Null when the list came from the plain token route (no market data). */
  market: DiscoverMarket | null;
}

export interface DiscoverQuery {
  sort?: DiscoverSort;
  mode?: "weekly" | "live";
  quotes?: readonly string[];
  categories?: readonly string[];
  regions?: readonly string[];
  q?: string;
  tokens?: readonly string[];
  cursor?: string;
  limit?: number;
}

export interface DiscoverPage extends Page<DiscoverToken> {
  total: number | null;
  /** `market`: full data from /api/discover. `basic`: the plain token list; `chain`: read from the chain logs. */
  source: "market" | "basic" | "chain";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const flt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const big = (v: unknown): bigint => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return 0n;
};
const ZERO_BYTES32 = /^0x0{64}$/i;
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function toDiscoverMarket(v: unknown): DiscoverMarket | null {
  if (!isRecord(v)) return null;
  return {
    quote: str(v.quote),
    quoteDecimals: int(v.quoteDecimals),
    price: flt(v.price),
    change24h: flt(v.change24h),
    volume24hQuote: big(v.volume24hQuote),
    trades24h: int(v.trades24h) ?? 0,
    buys24h: int(v.buys24h) ?? 0,
    sells24h: int(v.sells24h) ?? 0,
    tradesTotal: int(v.tradesTotal) ?? 0,
    lastTradeAt: int(v.lastTradeAt),
    quoteInPool: big(v.quoteInPool),
    holders: int(v.holders),
    supply: typeof v.supply === "string" && /^\d+$/.test(v.supply) ? BigInt(v.supply) : null,
  };
}

export function toDiscoverToken(v: unknown): DiscoverToken | null {
  if (!isRecord(v) || typeof v.address !== "string") return null;
  const mode = isRecord(v.mode) && v.mode.kind === "live" ? { kind: "live" as const, period: int(v.mode.period) ?? 4, periodSeconds: int(v.mode.periodSeconds) ?? 604_800 } : { kind: "weekly" as const };
  const logo = str(v.logoRef);
  return {
    address: v.address,
    name: typeof v.name === "string" ? v.name : "",
    symbol: typeof v.symbol === "string" ? v.symbol : "",
    label: str(v.label),
    logoRef: logo && !ZERO_BYTES32.test(logo) ? logo : null,
    createdAt: int(v.createdAt),
    feeBps: int(v.feeBps),
    focus: isRecord(v.focus) ? { categories: strList(v.focus.categories), regions: strList(v.focus.regions) } : null,
    raised: big(v.raised),
    mode,
    market: toDiscoverMarket(v.market),
  };
}

/** A token from the plain list as a discover row without market data. */
export function basicDiscoverToken(t: TokenSummary): DiscoverToken {
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    label: t.label ?? null,
    logoRef: t.logoRef ?? null,
    createdAt: null,
    feeBps: t.feeBps ?? null,
    focus: null,
    raised: 0n,
    mode: { kind: "weekly" },
    market: null,
  };
}

/** Query-string parameters of a discover request. */
export function discoverParams(q: DiscoverQuery): Record<string, string | number | undefined> {
  const list = (a: readonly string[] | undefined) => (a && a.length ? a.join(",") : undefined);
  return {
    sort: q.sort,
    mode: q.mode,
    quotes: list(q.quotes),
    categories: list(q.categories),
    regions: list(q.regions),
    q: q.q?.trim() || undefined,
    tokens: list(q.tokens),
    cursor: q.cursor,
    limit: q.limit,
  };
}

export async function fetchDiscover(client: IndexerClient, q: DiscoverQuery): Promise<DiscoverPage> {
  const body = await client.get("/api/discover", discoverParams(q));
  if (!isRecord(body) || !Array.isArray(body.items)) throw new IndexerError("Unexpected discover response");
  return {
    items: body.items.map(toDiscoverToken).filter((t): t is DiscoverToken => t !== null),
    nextCursor: typeof body.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : null,
    total: int(body.total),
    source: "market",
  };
}

const matchesText = (t: DiscoverToken, q: string | undefined) => {
  const needle = (q ?? "").trim().toLowerCase().replace(/^\$/, "");
  return !needle || [t.name, t.symbol, t.label ?? "", t.address].some((s) => s.toLowerCase().includes(needle));
};

/**
 * One page for the discover list. Filters the plain-list fallback can't apply (pair, mode, cause)
 * are reported through `source`, so the view says market data is unavailable instead of showing
 * an unfiltered list as if it were filtered.
 */
export async function loadDiscover(cfg: AppConfig, deps: DataDeps, q: DiscoverQuery): Promise<DiscoverPage> {
  try {
    return await fetchDiscover(deps.indexer, q);
  } catch (discoverError) {
    // A 4xx is definitive (bad filter): surface it. Anything else falls back to the plain list.
    if (discoverError instanceof IndexerError && discoverError.status !== undefined && discoverError.status < 500 && discoverError.status !== 404) throw discoverError;
    try {
      const page = await deps.indexer.tokens({ cursor: q.cursor, limit: q.limit ?? 24 });
      return { items: page.items.map(basicDiscoverToken).filter((t) => matchesText(t, q.q)), nextCursor: page.nextCursor, total: null, source: "basic" };
    } catch {
      try {
        const items = (await chainTokens(deps.chain(), cfg, q.limit ?? 24)).map(basicDiscoverToken).filter((t) => matchesText(t, q.q));
        return { items, nextCursor: null, total: null, source: "chain" };
      } catch {
        throw discoverError;
      }
    }
  }
}
