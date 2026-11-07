import { describe, expect, it } from "vitest";
import { holder, holderDay, holderStat, token, tokenMarket, trade, tradeHour, tradeStat } from "ponder:schema";
import { type Hex, encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import { readApiConfig } from "../src/api/config";
import {
  type HolderLabel,
  type MarketRepo,
  type TradeHourRow,
  type TradeRow,
  fillDays,
  priceFromSqrt,
  shareOf,
  windowOf,
} from "../src/api/market";
import { createApi } from "../src/api/routes";
import type { Repo } from "../src/api/types";
import { decodePoolSwap, onPoolTransfer, onTokenTransfer } from "../src/handlers/market";
import { POOL_MANAGER, PoolManagerSwapAbi } from "../src/pool-manager";
import { createFakeContext } from "./fakeDb";

declare global {
  interface Response {
    json(): Promise<any>;
  }
}

const TOKEN = "0x00000000000000000000000000000000000000a1" as Hex; // sorts below QUOTE
const HIGH_TOKEN = "0xf0000000000000000000000000000000000000a1" as Hex; // sorts above QUOTE
const QUOTE = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Hex;
const POOL = `0x${"11".repeat(32)}` as Hex;
const OTHER_POOL = `0x${"22".repeat(32)}` as Hex;
const ROUTER = "0x00000000000000000000000000000000000000f1" as Hex;
const ALICE = "0x00000000000000000000000000000000000000b1" as Hex;
const BOB = "0x00000000000000000000000000000000000000b2" as Hex;
const CREATOR = "0x00000000000000000000000000000000000000c1" as Hex;
const E18 = 10n ** 18n;
const DAY = 86_400;

const pks = () =>
  new Map<object, string[]>([
    [token, ["address"]],
    [holder, ["token", "account"]],
    [holderStat, ["token"]],
    [holderDay, ["token", "day"]],
    [tokenMarket, ["token"]],
    [trade, ["id"]],
    [tradeHour, ["token", "hour"]],
    [tradeStat, ["token"]],
  ]);

const block = (n: number, ts: number) => ({ number: BigInt(n), timestamp: BigInt(ts) });
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("holder balances", () => {
  const transfer = (h: ReturnType<typeof createFakeContext>, from: Hex, to: Hex, value: bigint, ts = 10 * DAY + 5): any =>
    onTokenTransfer({
      event: { args: { from, to, value }, block: block(1, ts), transaction: { hash: txh(1) }, log: { address: TOKEN } },
      context: h.context,
    } as never);

  it("tracks balances, the holder count, supply and the daily series", async () => {
    const h = createFakeContext(pks());
    await transfer(h, zeroAddress, POOL_MANAGER, 1_000n * E18);
    await transfer(h, POOL_MANAGER, ALICE, 100n * E18);
    await transfer(h, POOL_MANAGER, BOB, 50n * E18);
    let stat = h.rows(holderStat)[0]!;
    expect(stat).toMatchObject({ holders: 3, transfers: 3, supply: 1_000n * E18 });

    // Alice sells out: her row stays at zero and the count drops.
    await transfer(h, ALICE, POOL_MANAGER, 100n * E18, 11 * DAY + 1);
    stat = h.rows(holderStat)[0]!;
    expect(stat.holders).toBe(2);
    const alice = h.rows(holder).find((r) => r.account === ALICE)!;
    expect(alice).toMatchObject({ balance: 0n, firstSeenAt: BigInt(10 * DAY + 5), lastActiveAt: BigInt(11 * DAY + 1) });

    // A self-transfer and a zero-value transfer change nothing.
    await transfer(h, BOB, BOB, 50n * E18, 11 * DAY + 2);
    await transfer(h, BOB, ALICE, 0n, 11 * DAY + 3);
    expect(h.rows(holderStat)[0]!.holders).toBe(2);
    expect(h.rows(holder).find((r) => r.account === BOB)!.balance).toBe(50n * E18);

    // A burn lowers supply but is not a holder.
    await transfer(h, BOB, zeroAddress, 10n * E18, 11 * DAY + 4);
    expect(h.rows(holderStat)[0]).toMatchObject({ holders: 2, supply: 990n * E18 });
    expect(h.rows(holder).some((r) => r.account === zeroAddress)).toBe(false);

    expect(h.rows(holderDay).map((r) => [r.day, r.holders])).toEqual([
      [BigInt(10 * DAY), 3],
      [BigInt(11 * DAY), 2],
    ]);
  });

  it("clamps a balance that would go negative after a missed event", async () => {
    const h = createFakeContext(pks());
    await transfer(h, ALICE, BOB, 5n);
    expect(h.rows(holder).find((r) => r.account === ALICE)!.balance).toBe(0n);
    expect(h.rows(holderStat)[0]!.holders).toBe(1);
  });
});

/** A PoolManager Swap log; amounts are the swapper's deltas. */
const swapLog = (pool: Hex, amount0: bigint, amount1: bigint, logIndex: number, tick = -100, sqrt = 2n ** 96n) => ({
  address: POOL_MANAGER,
  logIndex,
  topics: encodeEventTopics({ abi: PoolManagerSwapAbi, eventName: "Swap", args: { id: pool, sender: ROUTER } }) as Hex[],
  data: encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [amount0, amount1, sqrt, 10n ** 20n, tick, 30_000],
  ),
});

describe("decodePoolSwap", () => {
  it("reads the side from the token's delta for either sort order", () => {
    // Token is currency0: +token to the swapper is a buy paid in currency1.
    expect(decodePoolSwap(swapLog(POOL, 5n * E18, -2n * E18, 0), POOL, true)).toMatchObject({
      side: "buy",
      tokenAmount: 5n * E18,
      quoteAmount: 2n * E18,
      sender: expect.stringMatching(/^0x0+f1$/i),
      feePips: 30_000,
      tick: -100,
    });
    // Token is currency1: the swapper paid token (negative amount1), so it is a sell.
    expect(decodePoolSwap(swapLog(POOL, 3n, -7n, 0), POOL, false)).toMatchObject({ side: "sell", tokenAmount: 7n, quoteAmount: 3n });
  });

  it("ignores other pools and other contracts", () => {
    expect(decodePoolSwap(swapLog(OTHER_POOL, 1n, -1n, 0), POOL, true)).toBeNull();
    expect(decodePoolSwap({ ...swapLog(POOL, 1n, -1n, 0), address: ROUTER }, POOL, true)).toBeNull();
  });
});

describe("trades", () => {
  const setup = async (tokenAddr: Hex, logs: object[]) => {
    const reads: string[] = [];
    const h = createFakeContext(pks(), async ({ functionName }) => {
      reads.push(functionName);
      if (functionName === "quoteAssetOf") return QUOTE;
      throw new Error("unexpected");
    });
    (h.client as unknown as { getTransactionReceipt: unknown }).getTransactionReceipt = async () => ({ logs });
    await h.context.db.insert(token).values({ address: tokenAddr, pool: POOL, creator: CREATOR } as never);
    return { h, reads };
  };
  const poolTransfer = (h: ReturnType<typeof createFakeContext>, tokenAddr: Hex, hash: Hex, ts: number): any =>
    onPoolTransfer({
      event: {
        args: { from: POOL_MANAGER, to: ALICE, value: 1n },
        block: block(7, ts),
        transaction: { hash, from: ALICE },
        log: { address: tokenAddr },
      },
      context: h.context,
    } as never);

  it("records each Swap of the token's pool once, with hourly and lifetime totals", async () => {
    const hour = 500 * 3_600;
    const { h, reads } = await setup(TOKEN, [
      swapLog(POOL, 10n * E18, -1n * E18, 3, -50),
      swapLog(OTHER_POOL, 1n, -1n, 4),
      { address: ROUTER, logIndex: 5, topics: [], data: "0x" },
    ]);
    // Two transfers of the same swap transaction (PoolManager -> router -> trader).
    await poolTransfer(h, TOKEN, txh(9), hour + 10);
    await poolTransfer(h, TOKEN, txh(9), hour + 10);
    expect(h.rows(trade)).toHaveLength(1);
    expect(h.rows(trade)[0]).toMatchObject({
      id: `${txh(9)}-3`,
      side: "buy",
      trader: ALICE,
      tokenAmount: 10n * E18,
      quote: QUOTE,
      quoteAmount: E18,
      tick: -50,
      logIndex: 3,
    });
    expect(reads).toEqual(["quoteAssetOf"]);
    expect(h.rows(tokenMarket)[0]).toMatchObject({ quote: QUOTE, tokenIsCurrency0: true });

    // A sell later in the same hour.
    (h.client as unknown as { getTransactionReceipt: unknown }).getTransactionReceipt = async () => ({
      logs: [swapLog(POOL, -4n * E18, E18 / 2n, 1, -70)],
    });
    await poolTransfer(h, TOKEN, txh(10), hour + 900);
    expect(h.rows(tradeHour)).toEqual([
      expect.objectContaining({
        hour: BigInt(hour),
        buys: 1,
        sells: 1,
        buyQuote: E18,
        sellQuote: E18 / 2n,
        buyToken: 10n * E18,
        sellToken: 4n * E18,
        openTick: -50,
        highTick: -50,
        lowTick: -70,
        closeTick: -70,
      }),
    ]);
    expect(h.rows(tradeStat)[0]).toMatchObject({ trades: 2, buys: 1, sells: 1, volumeQuote: (3n * E18) / 2n, lastTick: -70 });
    expect(reads).toEqual(["quoteAssetOf"]);
  });

  it("uses currency1 deltas when the token sorts above the quote", async () => {
    const { h } = await setup(HIGH_TOKEN, [swapLog(POOL, -2n * E18, 9n * E18, 0)]);
    await poolTransfer(h, HIGH_TOKEN, txh(11), 1_000);
    expect(h.rows(trade)[0]).toMatchObject({ side: "buy", tokenAmount: 9n * E18, quoteAmount: 2n * E18 });
  });

  it("adds nothing for a transaction without a Swap (liquidity, fee collection)", async () => {
    const { h, reads } = await setup(TOKEN, [{ address: POOL_MANAGER, logIndex: 0, topics: [`0x${"00".repeat(32)}`], data: "0x" }]);
    await poolTransfer(h, TOKEN, txh(12), 1_000);
    expect(h.rows(trade)).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});

describe("market math", () => {
  it("prices from sqrtPriceX96 in quote per whole token", () => {
    // sqrt price 1 => 1 raw currency1 per raw currency0.
    expect(priceFromSqrt(2n ** 96n, true, 18)).toBe(1);
    // Token is currency1 and the quote has 6 decimals: 4 raw token per raw quote => 0.25e12 quote per token.
    expect(priceFromSqrt(2n ** 97n, false, 6)).toBeCloseTo(0.25e12);
    expect(priceFromSqrt(0n, true, 18)).toBe(0);
  });

  it("shares, day series and windows", () => {
    expect(shareOf(1n, 3n)).toBe(33.3333);
    expect(shareOf(5n, 0n)).toBe(0);
    expect(fillDays([{ day: 0n, holders: 2 }, { day: 172_800n, holders: 5 }], 0n, 259_200n)).toEqual([
      { day: 0n, holders: 2 },
      { day: 86_400n, holders: 2 },
      { day: 172_800n, holders: 5 },
      { day: 259_200n, holders: 5 },
    ]);
    const row = (buys: number, sells: number): TradeHourRow => ({
      hour: 0n, buys, sells, buyQuote: BigInt(buys), sellQuote: BigInt(sells), buyToken: 0n, sellToken: 0n,
      openTick: 0, highTick: 0, lowTick: 0, closeTick: 0, closeSqrtPriceX96: 0n,
    });
    expect(windowOf([row(3, 1), row(0, 0)])).toMatchObject({ trades: 4, buys: 3, sells: 1, volumeQuote: 4n, buyShare: 75 });
    expect(windowOf([]).buyShare).toBeNull();
  });
});

describe("market routes", () => {
  const NOW = 2_000_000;
  const tradeRow = (i: number, side: "buy" | "sell"): TradeRow => ({
    id: `${txh(i)}-0`, token: TOKEN, side, trader: i % 2 ? ALICE : BOB, sender: ROUTER, tokenAmount: BigInt(i) * E18,
    quote: QUOTE, quoteAmount: BigInt(i), sqrtPriceX96: 2n ** 96n, tick: 0, feePips: 10_000, blockNumber: BigInt(i),
    logIndex: 0, timestamp: BigInt(NOW - i * 60), txHash: txh(i),
  });
  const trades = [1, 2, 3, 4, 5].map((i) => tradeRow(i, i % 2 ? "buy" : "sell"));
  const balances: Record<string, bigint> = {
    [POOL_MANAGER.toLowerCase()]: 600n,
    [CREATOR]: 30n,
    [ALICE]: 250n,
    [BOB]: 120n,
  };
  const labels = new Map<string, HolderLabel>([
    [POOL_MANAGER.toLowerCase(), "pool"],
    [CREATOR, "creator"],
  ]);
  const market: MarketRepo = {
    market: async () => ({ quote: QUOTE, quoteDecimals: 18, tokenIsCurrency0: true }),
    trades: async (_t, q) =>
      trades
        .filter((r) => !q.side || r.side === q.side)
        .filter((r) => !q.before || r.timestamp < q.before.t || (r.timestamp === q.before.t && r.id < q.before.k))
        .slice(0, q.limit),
    holderStat: async (t) => (t === TOKEN ? { holders: 4, supply: 1_000n, transfers: 9 } : null),
    topHolders: async (_t, limit, exclude) =>
      Object.entries(balances)
        .filter(([a]) => !exclude.includes(a as Hex))
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, limit)
        .map(([account, balance]) => ({ account: account as Hex, balance, firstSeenAt: 0n })),
    buckets: async () => [
      { label: "1% or more", holders: 3, balance: 400n },
      { label: "0.1% to 1%", holders: 0, balance: 0n },
      { label: "0.01% to 0.1%", holders: 0, balance: 0n },
      { label: "Under 0.01%", holders: 0, balance: 0n },
    ],
    balancesOf: async (_t, accounts) => accounts.map((a) => ({ account: a, balance: balances[a.toLowerCase()] ?? 0n })),
    newHolders: async () => 2,
    holderDays: async () => [{ day: BigInt(NOW - (NOW % DAY) - DAY), holders: 3 }],
    hours: async () => [
      { hour: 0n, buys: 3, sells: 1, buyQuote: 30n, sellQuote: 10n, buyToken: 0n, sellToken: 0n, openTick: 0, highTick: 0, lowTick: 0, closeTick: 0, closeSqrtPriceX96: 2n ** 96n },
    ],
    tradeStat: async () => ({ trades: 5, buys: 3, sells: 2, volumeQuote: 15n, volumeToken: 15n, lastSqrtPriceX96: 2n ** 96n, lastTick: 0, lastTradeAt: BigInt(NOW - 60) }),
    labels: async () => labels,
  };
  const mk = (withMarket = true) =>
    createApi({
      repo: {} as Repo,
      search: { search: async () => [] },
      config: readApiConfig({}),
      market: withMarket ? market : undefined,
      now: () => NOW * 1000,
    });

  it("pages trades newest first and filters by side", async () => {
    const app = mk();
    const r1 = await (await app.request(`/api/tokens/${TOKEN}/trades?limit=2`)).json();
    expect(r1.items.map((t: { txHash: string }) => t.txHash)).toEqual([txh(1), txh(2)]);
    expect(r1.items[0]).toMatchObject({ side: "buy", price: 1, quoteDecimals: 18, tokenAmount: E18.toString() });
    const r2 = await (await app.request(`/api/tokens/${TOKEN}/trades?limit=2&cursor=${r1.nextCursor}`)).json();
    expect(r2.items.map((t: { txHash: string }) => t.txHash)).toEqual([txh(3), txh(4)]);
    const sells = await (await app.request(`/api/tokens/${TOKEN}/trades?side=sell`)).json();
    expect(sells.items.every((t: { side: string }) => t.side === "sell")).toBe(true);
    expect((await app.request(`/api/tokens/${TOKEN}/trades?side=both`)).status).toBe(400);
    expect((await app.request(`/api/tokens/not-an-address/trades`)).status).toBe(400);
    // No route filters by a wallet address (docs/PRIVACY.md): the parameter is ignored.
    const anyTrader = await (await app.request(`/api/tokens/${TOKEN}/trades?trader=${ALICE}`)).json();
    expect(anyTrader.items).toHaveLength(5);
  });

  it("ranks holders with shares and labels, optionally without contracts", async () => {
    const app = mk();
    const all = await (await app.request(`/api/tokens/${TOKEN}/holders`)).json();
    expect(all.items[0]).toMatchObject({ rank: 1, label: "pool", share: 60 });
    const people = await (await app.request(`/api/tokens/${TOKEN}/holders?exclude=contracts`)).json();
    expect(people.items.map((h: { account: string; share: number; label: string | null }) => [h.account, h.share, h.label])).toEqual([
      [ALICE, 25, null],
      [BOB, 12, null],
      [CREATOR, 3, "creator"],
    ]);
  });

  it("summarises concentration, bands and the holder series", async () => {
    const s = await (await mk().request(`/api/tokens/${TOKEN}/holders/summary`)).json();
    expect(s).toMatchObject({
      holders: 4,
      newHolders24h: 2,
      poolShare: 60,
      creatorShare: 3,
      contractShare: 60,
      top10Share: 40,
      buckets: [{ label: "1% or more", holders: 3, share: 40 }, expect.anything(), expect.anything(), expect.anything()],
    });
    expect(s.history).toHaveLength(2);
    expect((await mk().request(`/api/tokens/${ALICE}/holders/summary`)).status).toBe(404);
  });

  it("returns the window totals, buy share and price", async () => {
    const m = await (await mk().request(`/api/tokens/${TOKEN}/market?hours=24`)).json();
    expect(m).toMatchObject({ price: 1, window: { hours: 24, trades: 4, buyShare: 75, volumeQuote: "40" }, lifetime: { trades: 5 } });
    expect(m.hourly[0].closePrice).toBe(1);
    expect((await mk().request(`/api/tokens/${TOKEN}/market?hours=999`)).status).toBe(400);
  });

  it("answers 503 without a market repo", async () => {
    const r = await mk(false).request(`/api/tokens/${TOKEN}/trades`);
    expect(r.status).toBe(503);
  });
});
