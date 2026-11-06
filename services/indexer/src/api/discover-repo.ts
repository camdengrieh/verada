import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { eq, gte, sql } from "ponder";
import { joinDiscover, type DiscoverItem, type DiscoverRepo } from "./discover";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { token, feeTotal, tokenMarket, quoteAsset, tradeStat, tradeHour, holderStat, liveToken, liveSchedule } = schema;

const HOUR = 3_600n;
const DAY = 86_400n;

/** Bulk reads (one query per table, never per token), memoised for `ttlMs` so a busy page costs one scan. */
export function createDiscoverRepo(ttlMs = 5_000, now: () => number = Date.now): DiscoverRepo {
  let cache: { at: number; value: Promise<DiscoverItem[]> } | undefined;
  async function load(): Promise<DiscoverItem[]> {
    const nowSec = BigInt(Math.floor(now() / 1000));
    const since = nowSec - (nowSec % HOUR) - DAY + HOUR;
    const [tokens, fees, markets, quoteDecimals, stats, hours, flows, holders, live, liveSchedules] = await Promise.all([
      db.select().from(token).where(eq(token.suppressed, false)),
      db.select().from(feeTotal),
      db.select().from(tokenMarket),
      db.select({ asset: quoteAsset.asset, decimals: quoteAsset.decimals }).from(quoteAsset),
      db.select().from(tradeStat),
      db.select().from(tradeHour).where(gte(tradeHour.hour, since)),
      db
        .select({
          token: tradeHour.token,
          buyQuote: sql<string>`coalesce(sum(${tradeHour.buyQuote}), 0)`,
          sellQuote: sql<string>`coalesce(sum(${tradeHour.sellQuote}), 0)`,
        })
        .from(tradeHour)
        .groupBy(tradeHour.token),
      db.select().from(holderStat),
      db.select().from(liveToken),
      db.select().from(liveSchedule),
    ]);
    return joinDiscover({
      tokens,
      fees,
      markets,
      quoteDecimals,
      stats,
      hours,
      flows: flows.map((f: { token: `0x${string}`; buyQuote: string; sellQuote: string }) => ({ token: f.token, buyQuote: BigInt(f.buyQuote), sellQuote: BigInt(f.sellQuote) })),
      holders,
      live,
      liveSchedules,
    }, nowSec);
  }
  return {
    items() {
      if (!cache || now() - cache.at > ttlMs) {
        const value = load();
        cache = { at: now(), value };
        value.catch(() => {
          if (cache?.value === value) cache = undefined;
        });
      }
      return cache.value;
    },
  };
}
