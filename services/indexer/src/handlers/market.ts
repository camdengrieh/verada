import type { Context, Event } from "ponder:registry";
import { holder, holderDay, holderStat, token, tokenMarket, trade, tradeHour, tradeStat } from "ponder:schema";
import { type Hex, decodeEventLog, zeroAddress } from "viem";
import { VaradaFactoryAbi } from "../abis";
import { POOL_MANAGER, PoolManagerSwapAbi, SWAP_TOPIC } from "../pool-manager";

const HOUR = 3_600n;
const DAY = 86_400n;
const lc = (a: string) => a.toLowerCase();

type TransferEvent = Event<"VaradaToken:Transfer">;
type TransferContext = Context<"VaradaToken:Transfer">;

/**
 * Moves `value` between two balances. Returns +1 when `account` went from zero to nonzero, -1 for
 * the reverse, 0 otherwise.
 */
async function moveBalance(
  context: TransferContext,
  tokenAddr: Hex,
  account: Hex,
  delta: bigint,
  ts: bigint,
): Promise<number> {
  const key = { token: tokenAddr, account };
  const row = await context.db.find(holder, key);
  const prev = row?.balance ?? 0n;
  // A negative balance would mean a missed event; clamp so one gap cannot poison the counts.
  const next = prev + delta < 0n ? 0n : prev + delta;
  if (row) {
    await context.db.update(holder, key).set({ balance: next, lastActiveAt: ts });
  } else {
    await context.db.insert(holder).values({ ...key, balance: next, firstSeenAt: ts, lastActiveAt: ts });
  }
  if (prev === 0n && next > 0n) return 1;
  if (prev > 0n && next === 0n) return -1;
  return 0;
}

/** `VaradaToken:Transfer` — holder balances, holder count, supply and the daily holder series. */
export async function onTokenTransfer({ event, context }: { event: TransferEvent; context: TransferContext }) {
  const tokenAddr = event.log.address as Hex;
  const { from, to, value } = event.args;
  const ts = event.block.timestamp;
  let holdersDelta = 0;
  let supplyDelta = 0n;

  if (lc(from) === zeroAddress) supplyDelta += value;
  else holdersDelta += await moveBalance(context, tokenAddr, from, -value, ts);
  if (lc(to) === zeroAddress) supplyDelta -= value;
  else holdersDelta += await moveBalance(context, tokenAddr, to, value, ts);

  const stat = await context.db.find(holderStat, { token: tokenAddr });
  const holders = Math.max(0, (stat?.holders ?? 0) + holdersDelta);
  if (stat) {
    await context.db.update(holderStat, { token: tokenAddr }).set({
      holders,
      transfers: stat.transfers + 1,
      supply: stat.supply + supplyDelta,
      updatedAt: ts,
    });
  } else {
    await context.db
      .insert(holderStat)
      .values({ token: tokenAddr, holders, transfers: 1, supply: supplyDelta, updatedAt: ts });
  }

  const day = ts - (ts % DAY);
  const dayKey = { token: tokenAddr, day };
  if (await context.db.find(holderDay, dayKey)) await context.db.update(holderDay, dayKey).set({ holders });
  else await context.db.insert(holderDay).values({ ...dayKey, holders });
}

type PoolEvent = Event<"VaradaTokenPool:Transfer">;
type PoolContext = Context<"VaradaTokenPool:Transfer">;

/** Quote asset and sort order of a token's pool, read once from the factory and cached. */
async function resolveMarket(context: PoolContext, tokenAddr: Hex, pool: Hex) {
  const found = await context.db.find(tokenMarket, { token: tokenAddr });
  if (found) return found;
  let quote: Hex;
  try {
    quote = (await context.client.readContract({
      abi: VaradaFactoryAbi,
      address: context.contracts.Factory.address as Hex,
      functionName: "quoteAssetOf",
      args: [tokenAddr],
    })) as Hex;
  } catch {
    return null;
  }
  if (lc(quote) === zeroAddress) return null;
  const row = { token: tokenAddr, pool, quote, tokenIsCurrency0: lc(tokenAddr) < lc(quote) };
  await context.db.insert(tokenMarket).values(row).onConflictDoNothing();
  return row;
}

export interface DecodedSwap {
  side: "buy" | "sell";
  sender: Hex;
  tokenAmount: bigint;
  quoteAmount: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  feePips: number;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Turns a Swap log of `pool` into a trade, or null for any other log. */
export function decodePoolSwap(
  log: { address: string; topics: readonly Hex[]; data: Hex },
  pool: Hex,
  tokenIsCurrency0: boolean,
): DecodedSwap | null {
  if (lc(log.address) !== lc(POOL_MANAGER)) return null;
  if (log.topics[0] !== SWAP_TOPIC || !log.topics[1] || lc(log.topics[1]) !== lc(pool)) return null;
  const { args } = decodeEventLog({
    abi: PoolManagerSwapAbi,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const tokenDelta = tokenIsCurrency0 ? args.amount0 : args.amount1;
  const quoteDelta = tokenIsCurrency0 ? args.amount1 : args.amount0;
  if (tokenDelta === 0n) return null;
  return {
    side: tokenDelta > 0n ? "buy" : "sell",
    sender: args.sender,
    tokenAmount: abs(tokenDelta),
    quoteAmount: abs(quoteDelta),
    sqrtPriceX96: args.sqrtPriceX96,
    tick: args.tick,
    feePips: args.fee,
  };
}

async function bumpHour(context: PoolContext, tokenAddr: Hex, ts: bigint, s: DecodedSwap) {
  const key = { token: tokenAddr, hour: ts - (ts % HOUR) };
  const buy = s.side === "buy";
  const cur = await context.db.find(tradeHour, key);
  if (!cur) {
    await context.db.insert(tradeHour).values({
      ...key,
      buys: buy ? 1 : 0,
      sells: buy ? 0 : 1,
      buyQuote: buy ? s.quoteAmount : 0n,
      sellQuote: buy ? 0n : s.quoteAmount,
      buyToken: buy ? s.tokenAmount : 0n,
      sellToken: buy ? 0n : s.tokenAmount,
      openTick: s.tick,
      highTick: s.tick,
      lowTick: s.tick,
      closeTick: s.tick,
      closeSqrtPriceX96: s.sqrtPriceX96,
    });
    return;
  }
  await context.db.update(tradeHour, key).set({
    buys: cur.buys + (buy ? 1 : 0),
    sells: cur.sells + (buy ? 0 : 1),
    buyQuote: cur.buyQuote + (buy ? s.quoteAmount : 0n),
    sellQuote: cur.sellQuote + (buy ? 0n : s.quoteAmount),
    buyToken: cur.buyToken + (buy ? s.tokenAmount : 0n),
    sellToken: cur.sellToken + (buy ? 0n : s.tokenAmount),
    highTick: Math.max(cur.highTick, s.tick),
    lowTick: Math.min(cur.lowTick, s.tick),
    closeTick: s.tick,
    closeSqrtPriceX96: s.sqrtPriceX96,
  });
}

async function bumpStat(context: PoolContext, tokenAddr: Hex, ts: bigint, s: DecodedSwap) {
  const buy = s.side === "buy";
  const cur = await context.db.find(tradeStat, { token: tokenAddr });
  const last = { lastSqrtPriceX96: s.sqrtPriceX96, lastTick: s.tick, lastTradeAt: ts };
  if (!cur) {
    await context.db.insert(tradeStat).values({
      token: tokenAddr,
      trades: 1,
      buys: buy ? 1 : 0,
      sells: buy ? 0 : 1,
      volumeQuote: s.quoteAmount,
      volumeToken: s.tokenAmount,
      ...last,
    });
    return;
  }
  await context.db.update(tradeStat, { token: tokenAddr }).set({
    trades: cur.trades + 1,
    buys: cur.buys + (buy ? 1 : 0),
    sells: cur.sells + (buy ? 0 : 1),
    volumeQuote: cur.volumeQuote + s.quoteAmount,
    volumeToken: cur.volumeToken + s.tokenAmount,
    ...last,
  });
}

/**
 * `VaradaTokenPool:Transfer` — a transfer into or out of the PoolManager. The transaction receipt
 * (read through the cached client) holds the PoolManager `Swap` logs; each one on this token's pool becomes a trade. A swap moves
 * the token more than once (PoolManager, router, recipient), so trades are keyed by their Swap log
 * and recorded once. Liquidity moves and fee collection have no Swap log and add nothing.
 */
export async function onPoolTransfer({ event, context }: { event: PoolEvent; context: PoolContext }) {
  const tokenAddr = event.log.address as Hex;
  const tk = await context.db.find(token, { address: tokenAddr });
  if (!tk) return;
  const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
  let market: Awaited<ReturnType<typeof resolveMarket>> | undefined;
  for (const log of receipt.logs) {
    if (lc(log.address) !== lc(POOL_MANAGER) || log.topics[0] !== SWAP_TOPIC) continue;
    const logIndex = Number(log.logIndex);
    const id = `${event.transaction.hash}-${logIndex}`;
    if (await context.db.find(trade, { id })) continue;
    if (market === undefined) market = await resolveMarket(context, tokenAddr, tk.pool as Hex);
    if (!market) return;
    const s = decodePoolSwap(log as { address: string; topics: readonly Hex[]; data: Hex }, tk.pool as Hex, market.tokenIsCurrency0);
    if (!s) continue;
    const ts = event.block.timestamp;
    await context.db.insert(trade).values({
      id,
      token: tokenAddr,
      pool: tk.pool,
      side: s.side,
      trader: event.transaction.from,
      sender: s.sender,
      tokenAmount: s.tokenAmount,
      quote: market.quote,
      quoteAmount: s.quoteAmount,
      sqrtPriceX96: s.sqrtPriceX96,
      tick: s.tick,
      feePips: s.feePips,
      blockNumber: event.block.number,
      logIndex,
      timestamp: ts,
      txHash: event.transaction.hash,
    });
    await bumpHour(context, tokenAddr, ts, s);
    await bumpStat(context, tokenAddr, ts, s);
  }
}
