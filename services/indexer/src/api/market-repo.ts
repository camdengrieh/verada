import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { and, count, desc, eq, gt, gte, inArray, lt, notInArray, or, sql } from "ponder";
import type { Hex } from "viem";
import { POOL_MANAGER } from "../pool-manager";
import { DEAD, HOLDER_BUCKETS, type HolderLabel, type MarketRepo } from "./market";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { token, holder, holderStat, holderDay, tokenMarket, quoteAsset, trade, tradeHour, tradeStat, liveMode } = schema;

const collated = (expr: unknown) => sql`${expr} COLLATE "C"`;
const lower = (a: string) => a.toLowerCase() as Hex;

/** `platform` lists contracts labelled "vault" for every token (fee vault, consolidator…). */
export function createMarketRepo(platform: readonly string[] = []): MarketRepo {
  const vaults = platform.map(lower).filter((a) => !/^0x0{40}$/.test(a));
  return {
    async market(t) {
      const [m] = await db.select().from(tokenMarket).where(eq(tokenMarket.token, t)).limit(1);
      if (!m) return null;
      const [q] = await db.select({ decimals: quoteAsset.decimals }).from(quoteAsset).where(eq(quoteAsset.asset, m.quote)).limit(1);
      return { quote: m.quote, quoteDecimals: q?.decimals ?? null, tokenIsCurrency0: m.tokenIsCurrency0 };
    },
    async trades(t, q) {
      const cursor = q.before
        ? or(lt(trade.timestamp, q.before.t), and(eq(trade.timestamp, q.before.t), sql`${collated(trade.id)} < ${q.before.k}`))
        : undefined;
      return db
        .select()
        .from(trade)
        .where(and(eq(trade.token, t), q.side ? eq(trade.side, q.side) : undefined, cursor))
        .orderBy(desc(trade.timestamp), desc(collated(trade.id)))
        .limit(q.limit);
    },
    async holderStat(t) {
      const [s] = await db.select().from(holderStat).where(eq(holderStat.token, t)).limit(1);
      return s ? { holders: s.holders, supply: s.supply, transfers: s.transfers } : null;
    },
    async topHolders(t, limit, exclude) {
      return db
        .select({ account: holder.account, balance: holder.balance, firstSeenAt: holder.firstSeenAt })
        .from(holder)
        .where(and(eq(holder.token, t), gt(holder.balance, 0n), exclude.length ? notInArray(holder.account, exclude) : undefined))
        .orderBy(desc(holder.balance), collated(holder.account))
        .limit(limit);
    },
    async buckets(t, supply, exclude) {
      const floors = HOLDER_BUCKETS.map((b) => (b.divisor === null ? 0n : supply / b.divisor));
      // Band index of each balance: the first floor it reaches. The floors are inlined (they are
      // bigints computed here) so the SELECT and GROUP BY expressions match exactly.
      const band = sql<number>`CASE ${sql.join(
        floors.slice(0, -1).map((f, i) => sql`WHEN ${holder.balance} >= ${sql.raw(f.toString())} THEN ${sql.raw(String(i))}`),
        sql` `,
      )} ELSE ${sql.raw(String(floors.length - 1))} END`;
      const rows = await db
        .select({ band, holders: count(), balance: sql<string>`SUM(${holder.balance})` })
        .from(holder)
        .where(and(eq(holder.token, t), gt(holder.balance, 0n), exclude.length ? notInArray(holder.account, exclude) : undefined))
        .groupBy(band);
      return HOLDER_BUCKETS.map((b, i) => {
        const r = rows.find((x: { band: unknown }) => Number(x.band) === i);
        return { label: b.label, holders: Number(r?.holders ?? 0), balance: BigInt(r?.balance ?? 0) };
      });
    },
    async balancesOf(t, accounts) {
      if (accounts.length === 0) return [];
      return db
        .select({ account: holder.account, balance: holder.balance })
        .from(holder)
        .where(and(eq(holder.token, t), inArray(holder.account, accounts)));
    },
    async newHolders(t, since) {
      const [r] = await db
        .select({ n: count() })
        .from(holder)
        .where(and(eq(holder.token, t), gt(holder.balance, 0n), gte(holder.firstSeenAt, since)));
      return Number(r?.n ?? 0);
    },
    async holderDays(t, since) {
      return db
        .select({ day: holderDay.day, holders: holderDay.holders })
        .from(holderDay)
        .where(and(eq(holderDay.token, t), gte(holderDay.day, since)))
        .orderBy(holderDay.day);
    },
    async hours(t, since) {
      return db.select().from(tradeHour).where(and(eq(tradeHour.token, t), gte(tradeHour.hour, since))).orderBy(tradeHour.hour);
    },
    async tradeStat(t) {
      const [s] = await db.select().from(tradeStat).where(eq(tradeStat.token, t)).limit(1);
      return s ?? null;
    },
    async labels(t) {
      const out = new Map<string, HolderLabel>([
        [lower(POOL_MANAGER), "pool"],
        [DEAD, "burn"],
      ]);
      for (const v of vaults) out.set(v, "vault");
      const [live] = await db.select().from(liveMode).limit(1);
      for (const a of [live?.liveVault, live?.liveHook]) if (a) out.set(lower(a), "vault");
      const [row] = await db.select({ creator: token.creator }).from(token).where(eq(token.address, t)).limit(1);
      if (row) out.set(lower(row.creator), "creator");
      return out;
    },
  };
}
