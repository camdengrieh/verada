// Local mock of the browser-facing API: the real route layer (CORS, rate limits, cursors, SSE)
// over the in-memory fixture repository. Used for browser integration checks; never deployed.
//   pnpm --filter @varada/indexer serve:fixtures [port]
// Besides the core routes it serves synthetic trades, holders and hourly market rows for every
// fixture token, so the token page's market, trades and holders tabs have data. /api/discover and
// /api/agents are not wired and answer 503 (the web app falls back to /api/tokens).
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { ActivityBus } from "../src/api/bus";
import { readApiConfig } from "../src/api/config";
import type { HolderLabel, HolderRow, MarketRepo, TradeHourRow, TradeRow } from "../src/api/market";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "../test/api.fixtures";

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const QUOTE = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as const; // WETH
const ROUTER = "0x00000000000000000000000000000000000000f1" as const;
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90" as const;
const CREATOR = "0x00000000000000000000000000000000000000c1" as const;
const traders = [1, 2, 3, 4, 5].map((n) => `0x00000000000000000000000000000000000000b${n}` as const);

/** Deterministic synthetic market data: 60 trades over the last 60 hours, a handful of holders. */
function fixtureMarket(now: number): MarketRepo {
  const trades: TradeRow[] = Array.from({ length: 60 }, (_, i) => {
    const side = i % 3 === 0 ? "sell" : "buy";
    const tokenAmount = BigInt(1_000 + ((i * 37) % 900)) * E18;
    return {
      id: `0x${(i + 1).toString(16).padStart(64, "0")}-0`,
      token: "0x00" as `0x${string}`,
      side,
      trader: traders[i % traders.length]!,
      sender: ROUTER,
      tokenAmount,
      quote: QUOTE,
      quoteAmount: tokenAmount / 100_000n,
      // The price drifts up slowly, so the chart has a trend.
      sqrtPriceX96: Q96 + BigInt(60 - i) * (Q96 / 1_000n),
      tick: 60 - i,
      feePips: 10_000,
      blockNumber: BigInt(20_000_000 + 60 - i),
      logIndex: 0,
      timestamp: BigInt(now - (i + 1) * 3_600 + 60),
      txHash: `0x${(i + 1).toString(16).padStart(64, "0")}` as `0x${string}`,
    };
  });
  const balances = new Map<string, bigint>([
    [POOL_MANAGER, 600_000n * E18],
    [CREATOR, 50_000n * E18],
    ...traders.map((a, i) => [a, BigInt(150_000 - i * 25_000) * E18] as [string, bigint]),
  ]);
  const supply = [...balances.values()].reduce((a, b) => a + b, 0n);
  const labels = new Map<string, HolderLabel>([[POOL_MANAGER, "pool"], [CREATOR, "creator"]]);
  return {
    market: async () => ({ quote: QUOTE, quoteDecimals: 18, tokenIsCurrency0: true }),
    trades: async (_t, q) =>
      trades
        .filter((r) => !q.side || r.side === q.side)
        .filter((r) => !q.before || r.timestamp < q.before.t || (r.timestamp === q.before.t && r.id < q.before.k))
        .slice(0, q.limit),
    holderStat: async () => ({ holders: balances.size, supply, transfers: trades.length }),
    topHolders: async (_t, limit, exclude) =>
      [...balances.entries()]
        .filter(([a]) => !exclude.includes(a as `0x${string}`))
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, limit)
        .map(([account, balance]): HolderRow => ({ account: account as `0x${string}`, balance, firstSeenAt: BigInt(now - 86_400) })),
    buckets: async (_t, total, exclude) => {
      const rows = [...balances.entries()].filter(([a]) => !exclude.includes(a as `0x${string}`));
      const band = (min: bigint, max: bigint) => rows.filter(([, b]) => b * 100n >= total * min && b * 100n < total * max);
      const sum = (r: [string, bigint][]) => r.reduce((a, [, b]) => a + b, 0n);
      const big = band(1n, 101n);
      return [
        { label: "1% or more", holders: big.length, balance: sum(big) },
        { label: "0.1% to 1%", holders: 0, balance: 0n },
        { label: "0.01% to 0.1%", holders: 0, balance: 0n },
        { label: "Under 0.01%", holders: 0, balance: 0n },
      ];
    },
    balancesOf: async (_t, accounts) => accounts.map((a) => ({ account: a, balance: balances.get(a.toLowerCase()) ?? 0n })),
    newHolders: async () => 2,
    holderDays: async () => [1, 2, 3].map((d) => ({ day: BigInt(now - (now % 86_400) - (3 - d) * 86_400), holders: 3 + d })),
    hours: async (_t, since) =>
      trades
        .filter((r) => r.timestamp >= since)
        .map((r): TradeHourRow => ({
          hour: r.timestamp - (r.timestamp % 3_600n),
          buys: r.side === "buy" ? 1 : 0,
          sells: r.side === "sell" ? 1 : 0,
          buyQuote: r.side === "buy" ? r.quoteAmount : 0n,
          sellQuote: r.side === "sell" ? r.quoteAmount : 0n,
          buyToken: r.side === "buy" ? r.tokenAmount : 0n,
          sellToken: r.side === "sell" ? r.tokenAmount : 0n,
          openTick: r.tick,
          highTick: r.tick,
          lowTick: r.tick,
          closeTick: r.tick,
          closeSqrtPriceX96: r.sqrtPriceX96,
        }))
        .reverse(),
    tradeStat: async () => ({
      trades: trades.length,
      buys: trades.filter((r) => r.side === "buy").length,
      sells: trades.filter((r) => r.side === "sell").length,
      volumeQuote: trades.reduce((a, r) => a + r.quoteAmount, 0n),
      volumeToken: trades.reduce((a, r) => a + r.tokenAmount, 0n),
      lastSqrtPriceX96: trades[0]!.sqrtPriceX96,
      lastTick: trades[0]!.tick,
      lastTradeAt: trades[0]!.timestamp,
    }),
    labels: async () => labels,
  };
}

const port = Number(process.argv[2] ?? process.env.PORT ?? 42069);
const repo = fixtureRepo();
const config = readApiConfig(process.env);
const bus = new ActivityBus(() => repo.listActivity({ limit: 100 }), config.ssePollMs);
const app = createApi({
  repo,
  config,
  bus,
  market: fixtureMarket(Math.floor(Date.now() / 1000)),
  search: { search: async () => [] },
});
createServer(async (req, res) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const r = await app.fetch(
    new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, signal: ac.signal }),
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) Readable.fromWeb(r.body as never).pipe(res);
  else res.end();
}).listen(port, "127.0.0.1", () => console.log(`fixture indexer on http://127.0.0.1:${port}`));
