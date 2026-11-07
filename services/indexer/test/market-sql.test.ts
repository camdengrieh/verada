/**
 * The market SQL (src/api/market-repo.ts) against a real Postgres engine: PGlite, with the tables
 * created from ponder.schema.ts by Ponder's own DDL generator (see test/support/realdb.ts). The
 * other market tests stub the repo, so none of them would catch a wrong ORDER BY, cursor, GROUP BY
 * or NUMERIC comparison; these seed edge cases and compare with values worked out by hand.
 *
 * The whole file is skipped when the engine cannot be loaded.
 */
import { holder, holderDay, holderStat, liveMode, quoteAsset, token, tokenMarket, trade, tradeHour, tradeStat } from "ponder:schema";
import { eq } from "ponder";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { DEAD, HOLDER_BUCKETS, fillDays, shareOf, toHolderViews, windowOf } from "../src/api/market";
import { createMarketRepo } from "../src/api/market-repo";
import { POOL_MANAGER } from "../src/pool-manager";
import { type RealDb, openRealDb } from "./support/realdb";

const real = await openRealDb();
const suite = real ? describe : describe.skip;

const hex = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const E18 = 10n ** 18n;
const HOUR = 3_600n;
const DAY = 86_400n;

const QUOTE = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Hex;
const POOL = txh(0x11);
const CREATOR = hex(0xc1);
const VAULT = hex(0xaa01);
const LIVE_VAULT = hex(0xaa02);
const LIVE_HOOK = hex(0xaa03);

// Tokens: FULL (every case), SOLO (one holder), EMPTY (nothing indexed), OTHER (isolation check).
const FULL = hex(0xa1);
const SOLO = hex(0xa2);
const EMPTY = hex(0xa3);
const OTHER = hex(0xa4);

const SUPPLY = 1_000_000n * E18;
const ONE_PCT = SUPPLY / 100n; // 10_000 E18
const TENTH_PCT = SUPPLY / 1_000n;
const HUNDREDTH_PCT = SUPPLY / 10_000n;

// An hour-aligned "now" with an odd offset into the hour and the day.
const NOW_DAY = 1_700_006_400n; // 2023-11-15T00:00:00Z
const NOW = NOW_DAY + 13n * HOUR + 1_234n;
const NOW_HOUR = NOW - (NOW % HOUR);

const tokenRow = (address: Hex, creator: Hex) => ({
  address,
  creator,
  pool: POOL,
  hook: hex(0xb00),
  lpTokenId: 1n,
  feeBps: 100,
  metadataUri: "",
  createdAt: 1n,
  createdBlock: 1n,
  txHash: txh(1),
});

const balances: [Hex, bigint][] = [
  [POOL_MANAGER.toLowerCase() as Hex, 400_000n * E18],
  [DEAD, 50_000n * E18],
  [CREATOR, 200_000n * E18],
  [hex(0xb1), 150_000n * E18],
  [hex(0xb2), ONE_PCT], // exactly 1%: first band
  [hex(0xb3), ONE_PCT - 1n], // one wei under: second band
  [hex(0xb4), TENTH_PCT], // exactly 0.1%
  [hex(0xb5), TENTH_PCT - 1n],
  [hex(0xb6), HUNDREDTH_PCT], // exactly 0.01%
  [hex(0xb7), HUNDREDTH_PCT - 1n],
  [hex(0xb8), 1n], // dust
  [hex(0xb9), 0n], // sold out: kept as a row, not a holder
  [VAULT, 1_000n * E18],
];
const remainder = SUPPLY - balances.reduce((s, [, b]) => s + b, 0n);
balances.push([hex(0xba), remainder]);

suite("market repo on a real Postgres engine", () => {
  const r = real as RealDb;
  const repo = createMarketRepo([VAULT, "0x0000000000000000000000000000000000000000"]);

  beforeAll(async () => {
    const { db } = r;
    await db.insert(token).values([tokenRow(FULL, CREATOR), tokenRow(SOLO, hex(0xc2)), tokenRow(EMPTY, hex(0xc3)), tokenRow(OTHER, CREATOR)]);
    await db.insert(quoteAsset).values({ asset: QUOTE, decimals: 18, kind: 0, active: true, addedAt: 1n, updatedAt: 1n });
    await db.insert(liveMode).values({ id: "live", liveHook: LIVE_HOOK, liveVault: LIVE_VAULT, configuredAt: 1n, txHash: txh(2) });
    await db.insert(tokenMarket).values({ token: FULL, pool: POOL, quote: QUOTE, tokenIsCurrency0: true });

    await db.insert(holder).values(
      balances.map(([account, balance], i) => ({ token: FULL, account, balance, firstSeenAt: BigInt(1_000 + i), lastActiveAt: BigInt(2_000 + i) })),
    );
    // A second token, so the per-token filters are exercised.
    await db.insert(holder).values({ token: OTHER, account: hex(0xb1), balance: 5n * E18, firstSeenAt: 1n, lastActiveAt: 1n });
    await db.insert(holder).values({ token: SOLO, account: hex(0xd1), balance: 7n * E18, firstSeenAt: 5n, lastActiveAt: 5n });
    await db.insert(holderStat).values([
      { token: FULL, holders: balances.filter(([, b]) => b > 0n).length + 1, transfers: 40, supply: SUPPLY, updatedAt: 1n },
      { token: SOLO, holders: 1, transfers: 1, supply: 7n * E18, updatedAt: 1n },
    ]);

    // Holder counts per day: a gap between day -45 and day -29, one row older than the window.
    const day = (n: number) => NOW_DAY + BigInt(n) * DAY;
    await db.insert(holderDay).values([
      { token: FULL, day: day(-45), holders: 3 },
      { token: FULL, day: day(-29), holders: 9 },
      { token: FULL, day: day(-1), holders: 12 },
      { token: FULL, day: day(0), holders: 13 },
      { token: SOLO, day: day(-60), holders: 1 },
    ]);
    await db.insert(holder).values({ token: FULL, account: hex(0xbb), balance: 3n * E18, firstSeenAt: NOW - 100n, lastActiveAt: NOW - 100n });
    await db.insert(holder).values({ token: FULL, account: hex(0xbc), balance: 0n, firstSeenAt: NOW - 50n, lastActiveAt: NOW - 50n });

    // Trades. 100 and 101 share a timestamp but are different blocks; log 9 and 10 share a block.
    const t = (id: string, side: "buy" | "sell", ts: bigint, block: bigint, logIndex: number, trader: Hex = hex(0xb1)) => ({
      id,
      token: FULL,
      pool: POOL,
      side,
      trader,
      sender: hex(0xf1),
      tokenAmount: 1_000n * E18,
      quote: QUOTE,
      quoteAmount: E18,
      sqrtPriceX96: 2n ** 96n,
      tick: 0,
      feePips: 3_000,
      blockNumber: block,
      logIndex,
      timestamp: ts,
      txHash: txh(Number(block)),
    });
    await db.insert(trade).values([
      t(`${txh(100)}-9`, "buy", NOW - 500n, 100n, 9),
      t(`${txh(100)}-10`, "sell", NOW - 500n, 100n, 10),
      t(`${txh(101)}-2`, "buy", NOW - 500n, 101n, 2),
      t(`${txh(90)}-1`, "buy", NOW - 900n, 90n, 1),
      t(`${txh(80)}-5`, "sell", NOW - 3_000n, 80n, 5),
      t(`${txh(70)}-0`, "buy", NOW - 4_000n, 70n, 0),
      t(`${txh(102)}-0`, "sell", NOW - 100n, 102n, 0, hex(0xb2)),
    ]);
    await db.insert(trade).values({ ...t(`${txh(500)}-0`, "buy", 10n, 500n, 0), token: OTHER });

    const h = (hour: bigint, over: Partial<Record<string, number | bigint>> = {}) => ({
      token: FULL,
      hour,
      buys: 2,
      sells: 1,
      buyQuote: 3n * E18,
      sellQuote: E18,
      buyToken: 3_000n * E18,
      sellToken: 1_000n * E18,
      openTick: -10,
      highTick: 5,
      lowTick: -20,
      closeTick: 0,
      closeSqrtPriceX96: 2n ** 96n,
      ...over,
    });
    await db.insert(tradeHour).values([
      h(NOW_HOUR - 3n * HOUR),
      h(NOW_HOUR - 2n * HOUR, { buys: 0, sells: 4, buyQuote: 0n, sellQuote: 8n * E18 }),
      h(NOW_HOUR - 1n * HOUR),
      h(NOW_HOUR),
      { ...h(NOW_HOUR - 1n * HOUR), token: OTHER },
    ]);
    await db.insert(tradeStat).values({
      token: FULL,
      trades: 7,
      buys: 4,
      sells: 3,
      volumeQuote: 7n * E18,
      volumeToken: 7_000n * E18,
      lastSqrtPriceX96: 2n ** 96n,
      lastTick: 0,
      lastTradeAt: NOW - 100n,
    });
  });

  afterAll(async () => {
    await r.close();
  });

  describe("an unindexed token", () => {
    it("returns empty answers, never throws", async () => {
      expect(await repo.market(EMPTY)).toBeNull();
      expect(await repo.trades(EMPTY, { limit: 10 })).toEqual([]);
      expect(await repo.holderStat(EMPTY)).toBeNull();
      expect(await repo.topHolders(EMPTY, 10, [])).toEqual([]);
      expect(await repo.balancesOf(EMPTY, [DEAD])).toEqual([]);
      expect(await repo.balancesOf(EMPTY, [])).toEqual([]);
      expect(await repo.newHolders(EMPTY, 0n)).toBe(0);
      expect(await repo.holderDays(EMPTY, 0n)).toEqual([]);
      expect(await repo.hours(EMPTY, 0n)).toEqual([]);
      expect(await repo.tradeStat(EMPTY)).toBeNull();
      const b = await repo.buckets(EMPTY, 0n, []);
      expect(b.map((x) => [x.label, x.holders, x.balance])).toEqual(HOLDER_BUCKETS.map((x) => [x.label, 0, 0n]));
    });

    it("still labels the pool and burn address", async () => {
      const l = await repo.labels(EMPTY);
      expect(l.get(POOL_MANAGER.toLowerCase())).toBe("pool");
      expect(l.get(DEAD)).toBe("burn");
    });
  });

  describe("market", () => {
    it("joins the pool side with the quote decimals", async () => {
      expect(await repo.market(FULL)).toEqual({ quote: QUOTE, quoteDecimals: 18, tokenIsCurrency0: true });
    });

    it("has no decimals for a quote asset that is not registered", async () => {
      await r.db.insert(tokenMarket).values({ token: OTHER, pool: POOL, quote: hex(0x999), tokenIsCurrency0: false });
      expect(await repo.market(OTHER)).toEqual({ quote: hex(0x999), quoteDecimals: null, tokenIsCurrency0: false });
    });

    it("matches an upper-case address", async () => {
      expect(await repo.market(FULL.toUpperCase().replace("0X", "0x") as Hex)).not.toBeNull();
    });
  });

  describe("trades", () => {
    // Newest first by chain order: timestamp, then block, then log index.
    const chrono = [
      `${txh(102)}-0`,
      `${txh(101)}-2`,
      `${txh(100)}-10`,
      `${txh(100)}-9`,
      `${txh(90)}-1`,
      `${txh(80)}-5`,
      `${txh(70)}-0`,
    ];

    it("lists newest first in chain order, including log index 10 before 9", async () => {
      const rows = await repo.trades(FULL, { limit: 50 });
      expect(rows.map((x) => x.id)).toEqual(chrono);
    });

    it("only returns the token's own trades", async () => {
      expect((await repo.trades(OTHER, { limit: 50 })).map((x) => x.id)).toEqual([`${txh(500)}-0`]);
    });

    it("filters by side", async () => {
      expect((await repo.trades(FULL, { side: "sell", limit: 50 })).map((x) => x.id)).toEqual([
        `${txh(102)}-0`,
        `${txh(100)}-10`,
        `${txh(80)}-5`,
      ]);
    });

    it("pages with the (timestamp, id) cursor without gaps or repeats, for every page size", async () => {
      for (const size of [1, 2, 3, 4, 6]) {
        const seen: string[] = [];
        let before: { t: bigint; k: string } | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const rows = await repo.trades(FULL, { before, limit: size });
          if (rows.length === 0) break;
          seen.push(...rows.map((x) => x.id));
          const last = rows[rows.length - 1]!;
          before = { t: last.timestamp, k: last.id };
        }
        expect(seen, `page size ${size}`).toEqual(chrono);
      }
    });

    it("keeps the side filter across pages", async () => {
      const first = await repo.trades(FULL, { side: "buy", limit: 2 });
      const last = first[first.length - 1]!;
      const rest = await repo.trades(FULL, { side: "buy", limit: 10, before: { t: last.timestamp, k: last.id } });
      expect([...first, ...rest].map((x) => x.id)).toEqual([`${txh(101)}-2`, `${txh(100)}-9`, `${txh(90)}-1`, `${txh(70)}-0`]);
    });

    it("returns numbers as bigint with full precision", async () => {
      const [row] = await repo.trades(FULL, { limit: 1 });
      expect(row?.tokenAmount).toBe(1_000n * E18);
      expect(row?.blockNumber).toBe(102n);
      expect(typeof row?.timestamp).toBe("bigint");
    });
  });

  describe("holders", () => {
    it("reads the per-token stat", async () => {
      expect(await repo.holderStat(FULL)).toEqual({ holders: balances.filter(([, b]) => b > 0n).length + 1, supply: SUPPLY, transfers: 40 });
    });

    it("ranks nonzero balances, largest first, ties by address", async () => {
      const rows = await repo.topHolders(FULL, 100, []);
      const expected = [...balances, [hex(0xbb), 3n * E18] as [Hex, bigint]]
        .filter(([, b]) => b > 0n)
        .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));
      expect(rows.map((x) => [x.account, x.balance])).toEqual(expected);
      expect(rows.some((x) => x.balance === 0n)).toBe(false);
    });

    it("limits and excludes accounts", async () => {
      const contracts = [POOL_MANAGER.toLowerCase() as Hex, DEAD, VAULT];
      const rows = await repo.topHolders(FULL, 3, contracts);
      // creator 200,000 E18, the remainder holder (~177,900 E18), then 150,000 E18
      expect(rows.map((x) => x.account)).toEqual([CREATOR, hex(0xba), hex(0xb1)]);
      expect(rows.every((x) => !contracts.includes(x.account))).toBe(true);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.balance >= rows[1]!.balance && rows[1]!.balance >= rows[2]!.balance).toBe(true);
    });

    it("exclusion is case-insensitive in the address", async () => {
      const rows = await repo.topHolders(FULL, 100, [DEAD.toUpperCase().replace("0X", "0x") as Hex]);
      expect(rows.some((x) => x.account === DEAD)).toBe(false);
    });

    it("builds views with shares and labels", async () => {
      const labels = await repo.labels(FULL);
      const views = toHolderViews(await repo.topHolders(FULL, 3, []), SUPPLY, labels);
      expect(views[0]).toMatchObject({ rank: 1, account: POOL_MANAGER.toLowerCase(), label: "pool", share: 40 });
      expect(views.map((v) => v.rank)).toEqual([1, 2, 3]);
    });

    it("returns balances for given accounts only", async () => {
      const rows = await repo.balancesOf(FULL, [DEAD, CREATOR, hex(0xdead0)]);
      expect(rows.sort((a, b) => (a.account < b.account ? -1 : 1))).toEqual(
        [
          { account: DEAD, balance: 50_000n * E18 },
          { account: CREATOR, balance: 200_000n * E18 },
        ].sort((a, b) => (a.account < b.account ? -1 : 1)),
      );
      // The same account on another token is not mixed in.
      expect(await repo.balancesOf(OTHER, [hex(0xb1)])).toEqual([{ account: hex(0xb1), balance: 5n * E18 }]);
    });

    it("single holder: one row, one bucket", async () => {
      const rows = await repo.topHolders(SOLO, 10, []);
      expect(rows).toHaveLength(1);
      const b = await repo.buckets(SOLO, 7n * E18, []);
      expect(b.map((x) => x.holders)).toEqual([1, 0, 0, 0]);
      expect(b[0]!.balance).toBe(7n * E18);
      expect(shareOf(b[0]!.balance, 7n * E18)).toBe(100);
    });

    it("counts holders who are new since a time, never zero balances", async () => {
      expect(await repo.newHolders(FULL, NOW - DAY)).toBe(1); // 0xbb; 0xbc is zero; the rest are old
      expect(await repo.newHolders(FULL, NOW + 1n)).toBe(0);
      expect(await repo.newHolders(FULL, 0n)).toBe(balances.filter(([, b]) => b > 0n).length + 1);
      expect(await repo.newHolders(FULL, NOW - 100n)).toBe(1); // inclusive bound
      expect(await repo.newHolders(FULL, NOW - 99n)).toBe(0);
    });
  });

  describe("holder buckets", () => {
    const sumTo = (rows: { balance: bigint }[]) => rows.reduce((s, x) => s + x.balance, 0n);

    it("puts balances in bands by share of supply, boundaries inclusive", async () => {
      const b = await repo.buckets(FULL, SUPPLY, []);
      const inBand = (i: number) => {
        const lo = HOLDER_BUCKETS[i]!.divisor === null ? 0n : SUPPLY / HOLDER_BUCKETS[i]!.divisor!;
        const hi = i === 0 ? null : SUPPLY / HOLDER_BUCKETS[i - 1]!.divisor!;
        return [...balances, [hex(0xbb), 3n * E18] as [Hex, bigint]].filter(([, x]) => x > 0n && x >= lo && (hi === null || x < hi));
      };
      for (let i = 0; i < HOLDER_BUCKETS.length; i++) {
        expect(b[i]!.holders, HOLDER_BUCKETS[i]!.label).toBe(inBand(i).length);
        expect(b[i]!.balance, HOLDER_BUCKETS[i]!.label).toBe(inBand(i).reduce((s, [, x]) => s + x, 0n));
      }
      // Spot checks of the boundary accounts, by hand: pool, creator, 150k, 0xb2 (exactly 1%) and the
      // remainder holder are >= 1%.
      expect(b[0]!.holders).toBeGreaterThanOrEqual(5);
    });

    it("assigns exact-threshold and one-wei-under balances to different bands", async () => {
      // Only the boundary holders, all else excluded.
      const only = [hex(0xb2), hex(0xb3), hex(0xb4), hex(0xb5), hex(0xb6), hex(0xb7), hex(0xb8)];
      const exclude = balances.map(([a]) => a).filter((a) => !only.includes(a));
      exclude.push(hex(0xbb), hex(0xbc));
      const b = await repo.buckets(FULL, SUPPLY, exclude);
      expect(b.map((x) => x.holders)).toEqual([1, 2, 2, 2]); // b2 | b3,b4 | b5,b6 | b7,b8
      expect(b[3]!.balance).toBe(HUNDREDTH_PCT - 1n + 1n);
    });

    it("excludes accounts and keeps totals consistent", async () => {
      const all = await repo.buckets(FULL, SUPPLY, []);
      const ex = await repo.buckets(FULL, SUPPLY, [POOL_MANAGER.toLowerCase() as Hex, DEAD, VAULT]);
      expect(all.reduce((s, x) => s + x.holders, 0)).toBe((await repo.topHolders(FULL, 1000, [])).length);
      expect(sumTo(all) - sumTo(ex)).toBe(400_000n * E18 + 50_000n * E18 + 1_000n * E18);
    });

    it("never counts a zero balance", async () => {
      const b = await repo.buckets(FULL, SUPPLY, []);
      expect(b.reduce((s, x) => s + x.holders, 0)).toBe(balances.filter(([, x]) => x > 0n).length + 1);
    });

    it("is exact with a tiny supply whose band floors round to zero", async () => {
      // supply 150 wei: 1% is 1.5, which integer division floors to 1. A 1 wei holder owns 0.67%.
      await r.db.insert(holder).values([
        { token: EMPTY, account: hex(0xe1), balance: 1n, firstSeenAt: 1n, lastActiveAt: 1n },
        { token: EMPTY, account: hex(0xe2), balance: 2n, firstSeenAt: 1n, lastActiveAt: 1n },
        { token: EMPTY, account: hex(0xe3), balance: 147n, firstSeenAt: 1n, lastActiveAt: 1n },
      ]);
      const b = await repo.buckets(EMPTY, 150n, []);
      // 1/150 = 0.67% -> "0.1% to 1%"; 2/150 = 1.33% and 147/150 -> "1% or more"
      expect(b.map((x) => x.holders)).toEqual([2, 1, 0, 0]);
      await r.db.delete(holder).where(eq(holder.token, EMPTY));
    });

    it("handles a zero supply without a division or an empty CASE", async () => {
      const b = await repo.buckets(SOLO, 0n, []);
      expect(b.reduce((s, x) => s + x.holders, 0)).toBe(1);
    });
  });

  describe("holder history", () => {
    const day = (n: number) => NOW_DAY + BigInt(n) * DAY;
    const since = NOW - 30n * DAY; // mid-day, as the route computes it

    it("starts at the day that contains `since` and carries the count in from before it", async () => {
      const rows = await repo.holderDays(FULL, since);
      // since falls on day -30 (13h in). No row that day; the latest earlier row is day -45 (3 holders),
      // then day -29 (9), -1 (12), 0 (13).
      expect(rows).toEqual([
        { day: day(-30), holders: 3 },
        { day: day(-29), holders: 9 },
        { day: day(-1), holders: 12 },
        { day: day(0), holders: 13 },
      ]);
    });

    it("includes the row of the day that contains `since`", async () => {
      const rows = await repo.holderDays(FULL, day(-29) + 5n * HOUR);
      expect(rows[0]).toEqual({ day: day(-29), holders: 9 });
    });

    it("an old-only history is carried into the window", async () => {
      expect(await repo.holderDays(SOLO, since)).toEqual([{ day: day(-30), holders: 1 }]);
    });

    it("fills quiet days from the returned rows", async () => {
      const rows = await repo.holderDays(FULL, since);
      const out = fillDays(rows, rows[0]!.day, NOW);
      expect(out).toHaveLength(31);
      expect(out[0]).toEqual({ day: day(-30), holders: 3 });
      expect(out[1]).toEqual({ day: day(-29), holders: 9 });
      expect(out[28]).toEqual({ day: day(-2), holders: 9 });
      expect(out[29]).toEqual({ day: day(-1), holders: 12 });
      expect(out[30]).toEqual({ day: day(0), holders: 13 });
    });
  });

  describe("hourly volume", () => {
    it("returns hours from `since` inclusive, oldest first", async () => {
      const rows = await repo.hours(FULL, NOW_HOUR - 2n * HOUR);
      expect(rows.map((x) => x.hour)).toEqual([NOW_HOUR - 2n * HOUR, NOW_HOUR - HOUR, NOW_HOUR]);
    });

    it("rounds an unaligned `since` down to its hour so a boundary hour is not dropped", async () => {
      const rows = await repo.hours(FULL, NOW_HOUR - 2n * HOUR + 1n);
      expect(rows.map((x) => x.hour)).toEqual([NOW_HOUR - 2n * HOUR, NOW_HOUR - HOUR, NOW_HOUR]);
    });

    it("does not mix tokens and returns exact amounts", async () => {
      const rows = await repo.hours(FULL, 0n);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ buys: 2, sells: 1, buyQuote: 3n * E18, closeSqrtPriceX96: 2n ** 96n, openTick: -10, lowTick: -20 });
      expect((await repo.hours(OTHER, 0n)).map((x) => x.hour)).toEqual([NOW_HOUR - HOUR]);
    });

    it("sums a window and reports the buy share", async () => {
      const w = windowOf(await repo.hours(FULL, NOW_HOUR - 2n * HOUR));
      // hours -2 (0 buys, 4 sells), -1 (2, 1), 0 (2, 1)
      expect(w).toMatchObject({ trades: 10, buys: 4, sells: 6, buyQuote: 6n * E18, sellQuote: 10n * E18, volumeQuote: 16n * E18, buyShare: 40 });
    });

    it("an empty window has no buy share", async () => {
      expect(windowOf(await repo.hours(FULL, NOW_HOUR + 10n * HOUR))).toMatchObject({ trades: 0, buyShare: null });
    });

    it("an hour exactly on the UTC boundary belongs to itself, not the previous hour", async () => {
      const edge = NOW_HOUR + 5n * HOUR; // aligned
      await r.db.insert(tradeHour).values([
        { token: SOLO, hour: edge - 1n, buys: 1, sells: 0, buyQuote: 1n, sellQuote: 0n, buyToken: 1n, sellToken: 0n, openTick: 0, highTick: 0, lowTick: 0, closeTick: 0, closeSqrtPriceX96: 1n },
        { token: SOLO, hour: edge, buys: 1, sells: 0, buyQuote: 1n, sellQuote: 0n, buyToken: 1n, sellToken: 0n, openTick: 0, highTick: 0, lowTick: 0, closeTick: 0, closeSqrtPriceX96: 1n },
      ]);
      expect((await repo.hours(SOLO, edge)).map((x) => x.hour)).toEqual([edge]);
    });
  });

  describe("trade stat", () => {
    it("reads lifetime totals", async () => {
      expect(await repo.tradeStat(FULL)).toMatchObject({ trades: 7, buys: 4, sells: 3, volumeQuote: 7n * E18, lastTradeAt: NOW - 100n });
      expect(await repo.tradeStat(SOLO)).toBeNull();
    });
  });

  describe("labels", () => {
    it("names the pool, burn, platform vaults, live contracts and the token's creator", async () => {
      const l = await repo.labels(FULL);
      expect(l.get(POOL_MANAGER.toLowerCase())).toBe("pool");
      expect(l.get(DEAD)).toBe("burn");
      expect(l.get(VAULT)).toBe("vault");
      expect(l.get(LIVE_VAULT)).toBe("vault");
      expect(l.get(LIVE_HOOK)).toBe("vault");
      expect(l.get(CREATOR)).toBe("creator");
      expect(l.has("0x0000000000000000000000000000000000000000")).toBe(false);
    });

    it("labels each token's own creator", async () => {
      expect((await repo.labels(SOLO)).get(hex(0xc2))).toBe("creator");
      expect((await repo.labels(SOLO)).get(CREATOR)).toBeUndefined();
    });
  });
});
