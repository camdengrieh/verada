import { describe, expect, it, beforeEach } from "vitest";
import {
  NATIVE_CURRENCY,
  ONDO_INFRA,
  ONDO_TOKENS,
  USDC,
  WETH,
  applySlippage,
  buildTradeTransaction,
  checkOndoTradable,
  clearDiscoveryCache,
  complianceRevertReason,
  planExecution,
  poolIdOf,
  quoteTrade,
  spendAmount,
  varadaPoolKey,
  type VaradaMarketToken,
} from "../../src/index.js";
import { HOOK, TOKEN, fakePool } from "./helpers.js";

const weth = WETH.address;
const token: VaradaMarketToken = { address: TOKEN, symbol: "TKN", hook: HOOK, quote: WETH };
const tokenKey = varadaPoolKey(TOKEN, weth, HOOK);
const tokenId = poolIdOf(tokenKey);
const AAPL = ONDO_TOKENS.AAPLon.address;

interface World {
  pools: ReturnType<typeof fakePool>[];
  /** quoter: out per in (raw) for pool; keyed by poolId and direction */
  rate?: (poolId: string, zeroForOne: boolean) => number;
  paused?: Set<string>;
  blocked?: boolean;
  calls: string[];
}

function mockClient(w: World) {
  const rate = w.rate ?? (() => 1);
  const byId = new Map(w.pools.map((p) => [p.poolId, p]));
  const quoteStep = (poolId: string, zfo: boolean, amount: bigint, mode: "in" | "out") => {
    const r = rate(poolId, zfo);
    return mode === "in" ? BigInt(Math.floor(Number(amount) * r)) : BigInt(Math.ceil(Number(amount) / r));
  };
  return {
    async readContract(a: { address: string; functionName: string; args?: readonly unknown[] }) {
      w.calls.push(a.functionName);
      const args = (a.args ?? []) as any[];
      switch (a.functionName) {
        case "getSlot0": {
          const p = byId.get(args[0]);
          return p ? [p.sqrtPriceX96, 0, 0, p.lpFee] : [0n, 0, 0, 0];
        }
        case "getLiquidity":
          return byId.get(args[0])?.liquidity ?? 0n;
        case "quoteExactInputSingle":
        case "quoteExactOutputSingle": {
          const { poolKey, zeroForOne, exactAmount } = args[0];
          const id = poolIdOf(poolKey);
          if (!byId.has(id)) throw new Error("PoolNotInitialized 0x486aa307");
          return [quoteStep(id, zeroForOne, exactAmount, a.functionName === "quoteExactInputSingle" ? "in" : "out"), 100_000n];
        }
        case "quoteExactInput": {
          const { exactCurrency, path, exactAmount } = args[0];
          let cur = exactCurrency as string;
          let amt = exactAmount as bigint;
          for (const pk of path) {
            const [c0, c1] = BigInt(cur) < BigInt(pk.intermediateCurrency) ? [cur, pk.intermediateCurrency] : [pk.intermediateCurrency, cur];
            const id = poolIdOf({ currency0: c0, currency1: c1, fee: pk.fee, tickSpacing: pk.tickSpacing, hooks: pk.hooks });
            if (!byId.has(id)) throw new Error("NotEnoughLiquidity 0x7a5ed734");
            amt = quoteStep(id, cur === c0, amt, "in");
            cur = pk.intermediateCurrency;
          }
          return [amt, 200_000n];
        }
        case "currentFeeBps":
          return 300;
        case "feeConfig":
          return { baseFeeBps: 100, surchargeStartBps: 4000, decaySeconds: 600, launchTimestamp: 1 };
        case "vault":
          throw new Error("execution reverted");
        case "tokenPauseManager":
          return ONDO_INFRA.tokenPauseManager;
        case "isTokenPaused":
          return w.paused?.has(String(args[0]).toLowerCase()) ?? false;
        case "allTokensPaused":
          return false;
        case "checkIsCompliant":
          if (w.blocked) throw new Error("The contract function reverted: UserBlocked()");
          return undefined;
        case "allowance":
          return a.address.toLowerCase() === weth.toLowerCase() || a.address === USDC.address ? 0n : [0n, 0, 0];
        default:
          throw new Error("unexpected call " + a.functionName);
      }
    },
  };
}

let world: World;
beforeEach(() => {
  clearDiscoveryCache();
  world = { pools: [fakePool(TOKEN, weth, 0x800000, 200, 10n ** 18n, { hooks: HOOK, sqrtPriceX96: 2n ** 96n }), fakePool(NATIVE_CURRENCY, USDC.address, 500, 10, 10n ** 15n)], calls: [] };
});

describe("quoteTrade", () => {
  it("buys with ETH through a wrap and reports fee, split and limits", async () => {
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 }, amount: 10n ** 18n, slippageBps: 100 });
    expect(q.routeLabel).toBe("ETH > WETH > TKN");
    expect(q.amountIn).toBe(10n ** 18n);
    expect(q.amountOut).toBe(1000n * 10n ** 18n);
    expect(q.amountOutMin).toBe((1000n * 10n ** 18n * 9900n) / 10_000n);
    expect(q.fee).toMatchObject({ feeBps: 300, baseFeeBps: 100, sniperBps: 200, sniperActive: true, causeShareBps: 9000, platformShareBps: 1000 });
    expect(q.feeFraction).toBeCloseTo(0.03, 10);
    expect(q.blockers).toEqual([]);
    expect(q.tokenPool?.poolId).toBe(tokenId);
    expect(q.best.route.steps.map((s) => s.kind)).toEqual(["wrap", "pool"]);
  });

  it("computes price impact net of the fee", async () => {
    // mid price 1:1 (sqrtPrice 2^96); pay 1 WETH, get 0.9 token-units after a 3% fee -> impact = 1 - 0.9 / (1 * 0.97)
    world.rate = (id) => (id === tokenId ? 0.9 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 });
    const zeroForOne = weth.toLowerCase() < TOKEN.toLowerCase();
    expect(zeroForOne).toBe(false); // token (0x11..) sorts below WETH
    expect(q.best.executionPrice).toBeCloseTo(0.9, 10);
    expect(q.best.midPrice).toBeCloseTo(1, 10);
    expect(q.best.priceImpactPct).toBeCloseTo((1 - 0.9 / 0.97) * 100, 6);
    expect(q.best.totalFeePct).toBeCloseTo(3, 10);
  });

  it("never reports negative impact", async () => {
    world.rate = (id) => (id === tokenId ? 1.2 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 });
    expect(q.best.priceImpactPct).toBe(0);
  });

  it("routes a USDC payment through the ETH/USDC pool, a wrap and the token pool", async () => {
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: USDC, amount: 1_000_000n, slippageBps: 50 });
    expect(q.routeLabel).toBe("USDC > ETH > WETH > TKN");
    expect(q.best.route.steps.map((s) => s.kind)).toEqual(["pool", "wrap", "pool"]);
  });

  it("tries the next routes when the most promising ones cannot fill the size", async () => {
    // a thin WETH/USDC pool looks fine by its reserves but its quote runs out of liquidity
    const thin = fakePool(weth, USDC.address, 500, 10, 10n ** 30n);
    world.pools.push(thin);
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const client = mockClient(world);
    const real = client.readContract.bind(client);
    client.readContract = async (a) => {
      if (a.functionName === "quoteExactInputSingle" && poolIdOf((a.args as any[])[0].poolKey) === thin.poolId) throw new Error("UnexpectedRevertBytes NotEnoughLiquidity 0x7a5ed734");
      if (a.functionName === "quoteExactInput" && JSON.stringify((a.args as any[])[0].path.map((p: any) => p.fee)).includes("500")) {
        const path = (a.args as any[])[0].path;
        if (path.length === 2 && path[0].intermediateCurrency === weth) throw new Error("NotEnoughLiquidity 0x7a5ed734");
      }
      return real(a);
    };
    // quote one route at a time so the failure of the first forces a second round
    const q = await quoteTrade(client as never, { token, side: "buy", asset: USDC, amount: 1_000_000n, slippageBps: 50 }, { routing: { quoteTop: 1 } });
    expect(q.best.route.steps.map((s) => s.kind)).toEqual(["pool", "wrap", "pool"]);
  });

  it("reports the liquidity error when no route can fill the size", async () => {
    world.rate = () => 1;
    const client = mockClient(world);
    client.readContract = async (a) => {
      if (String(a.functionName).startsWith("quote")) throw new Error("UnexpectedRevertBytes NotEnoughLiquidity 0x7a5ed734");
      return mockClient(world).readContract(a);
    };
    await expect(quoteTrade(client as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 })).rejects.toMatchObject({ reason: "insufficient-liquidity" });
    // a dead network stops the search at once instead of trying every route
    const dead = mockClient(world);
    let calls = 0;
    const real = dead.readContract.bind(dead);
    dead.readContract = async (a) => {
      if (String(a.functionName).startsWith("quote")) { calls++; throw new Error("HTTP request failed."); }
      return real(a);
    };
    await expect(quoteTrade(dead as never, { token, side: "buy", asset: USDC, amount: 1_000_000n, slippageBps: 50 }, { routing: { quoteTop: 1 } })).rejects.toMatchObject({ reason: "rpc-unavailable" });
    expect(calls).toBe(1);
  });

  it("sells to ETH: pool then unwrap", async () => {
    world.rate = (id) => (id === tokenId ? 0.001 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "sell", asset: { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 }, amount: 500n * 10n ** 18n, slippageBps: 100 });
    expect(q.routeLabel).toBe("TKN > WETH > ETH");
    expect(q.payAsset.symbol).toBe("TKN");
    expect(q.receiveAsset.symbol).toBe("ETH");
    expect(q.amountOut).toBe(5n * 10n ** 17n);
  });

  it("quotes exact-out", async () => {
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 500n * 10n ** 18n, mode: "exactOut", slippageBps: 100 });
    expect(q.mode).toBe("exactOut");
    expect(q.amountOut).toBe(500n * 10n ** 18n);
    expect(q.amountIn).toBe(5n * 10n ** 17n);
    expect(q.amountInMax).toBe((5n * 10n ** 17n * 10_100n + 9_999n) / 10_000n);
    expect(spendAmount(q)).toBe(q.amountInMax);
  });

  it("throws typed errors", async () => {
    await expect(quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 0n, slippageBps: 50 })).rejects.toMatchObject({ reason: "zero-amount" });
    // pay in a token with no pools at all
    await expect(quoteTrade(mockClient(world) as never, { token, side: "buy", asset: { address: AAPL, symbol: "AAPLon", decimals: 18 }, amount: 10n ** 18n, slippageBps: 50 })).rejects.toMatchObject({ reason: "no-route" });
    // the token's own pool missing
    world.pools = world.pools.slice(1);
    clearDiscoveryCache();
    await expect(quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 })).rejects.toMatchObject({ reason: "pool-not-initialized" });
    await expect(quoteTrade(mockClient(world) as never, { token, side: "buy", asset: { ...WETH, address: TOKEN }, amount: 1n, slippageBps: 50 })).rejects.toMatchObject({ reason: "unsupported-asset" });
  });

  it("blocks a trade whose price impact reaches the limit", async () => {
    // the pool's mid price is 1 but the quote only returns 0.2: a 79% shortfall net of the 3% fee
    world.rate = (id) => (id === tokenId ? 0.2 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 });
    expect(q.best.priceImpactPct).toBeGreaterThan(75);
    expect(q.blockers).toEqual(["price-impact"]);
    expect(() => buildTradeTransaction(q)).toThrow(expect.objectContaining({ reason: "price-impact" }));
    // the limit is configurable
    const lax = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 }, { maxImpactPct: 90 });
    expect(lax.blockers).toEqual([]);
  });

  it("only warns when the paused Ondo token is an intermediate hop that never moves", async () => {
    // ETH -> AAPLon -> WETH beats the wrap, and AAPLon is paused
    world.pools.push(fakePool(NATIVE_CURRENCY, AAPL, 500, 10, 10n ** 20n), fakePool(AAPL, weth, 500, 10, 10n ** 20n));
    world.rate = (id, zfo) => (id === tokenId ? 1000 : 1);
    const client = mockClient(world);
    const real = client.readContract.bind(client);
    // the AAPLon pools pay out 10% more than the plain wrap, so that route wins
    client.readContract = async (a) => {
      if (a.functionName === "quoteExactInput") {
        const out = (await real(a)) as [bigint, bigint];
        return [out[0] + out[0] / 10n, out[1]];
      }
      return real(a);
    };
    world.paused = new Set([AAPL.toLowerCase()]);
    const q = await quoteTrade(client as never, { token, side: "buy", asset: { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 }, amount: 10n ** 18n, slippageBps: 50 }, { routing: { extraHubs: [{ address: AAPL, symbol: "AAPLon", decimals: 18 }] }, compliance: { account: USDC.address, accountClient: { readContract: async () => { throw new Error("must not read the account for an intermediate hop"); } } as never } });
    expect(q.routeLabel).toContain("AAPL");
    expect(q.blockers).toEqual([]);
    expect(q.compliance.warnings).toEqual([expect.objectContaining({ reason: "paused", symbol: "AAPLon" })]);
  });

  it("flags a paused Ondo quote asset as a blocker and a closed market as a warning", async () => {
    const ondoToken: VaradaMarketToken = { ...token, quote: { address: AAPL, symbol: "AAPLon", decimals: 18 } };
    world.pools = [fakePool(TOKEN, AAPL, 0x800000, 200, 10n ** 18n, { hooks: HOOK })];
    // this token's key uses the AAPL quote
    const id = poolIdOf(varadaPoolKey(TOKEN, AAPL, HOOK));
    world.rate = () => 2;
    world.paused = new Set([AAPL.toLowerCase()]);
    const q = await quoteTrade(mockClient(world) as never, { token: ondoToken, side: "buy", asset: { address: AAPL, symbol: "AAPLon", decimals: 18 }, amount: 10n ** 18n, slippageBps: 50 }, { compliance: { marketOpen: false } });
    expect(world.pools[0]!.poolId).toBe(id);
    expect(q.blockers).toEqual(["paused"]);
    expect(q.compliance.warnings.map((w) => w.reason)).toEqual(["market-closed"]);
    expect(q.compliance.blockers[0]).toMatchObject({ reason: "paused", symbol: "AAPLon" });
    expect(() => buildTradeTransaction(q)).toThrow(expect.objectContaining({ reason: "paused" }));
  });
});

describe("compliance", () => {
  it("uses the account client for the user's address and maps blocked / sanctioned", async () => {
    const publicCalls: string[] = [];
    const accountCalls: string[] = [];
    const publicClient = { readContract: async (a: any) => { publicCalls.push(a.functionName); return a.functionName === "tokenPauseManager" ? ONDO_INFRA.tokenPauseManager : false; } };
    const accountClient = { readContract: async (a: any) => { accountCalls.push(a.functionName); throw new Error("reverted with custom error 0x349e7009"); } };
    const r = await checkOndoTradable(publicClient as never, [AAPL, weth], { account: USDC.address, accountClient: accountClient as never });
    expect(publicCalls).not.toContain("checkIsCompliant");
    expect(accountCalls).toEqual(["checkIsCompliant"]);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]!.reason).toBe("sanctioned");
    expect(r.checked).toEqual([AAPL]);
  });

  it("does not call anything for non-Ondo routes", async () => {
    const client = { readContract: async () => { throw new Error("must not be called"); } };
    expect(await checkOndoTradable(client as never, [weth, USDC.address])).toEqual({ blockers: [], warnings: [], checked: [] });
  });

  it("does not read a dead network as a blocked address", async () => {
    expect(complianceRevertReason(new Error("HTTP request failed."))).toBeNull();
    expect(complianceRevertReason(new Error("execution reverted"))).toBe("blocked");
    const publicClient = { readContract: async (a: any) => (a.functionName === "tokenPauseManager" ? ONDO_INFRA.tokenPauseManager : false) };
    const accountClient = { readContract: async () => { throw new Error("HTTP request failed."); } };
    await expect(checkOndoTradable(publicClient as never, [AAPL], { account: weth, accountClient: accountClient as never })).rejects.toThrow(/HTTP request failed/);
  });

  it("treats a token without a pause manager (USDon) as not paused", async () => {
    const client = { readContract: async () => { throw new Error("no such function"); } };
    const r = await checkOndoTradable(client as never, [ONDO_TOKENS.USDon.address]);
    expect(r.blockers).toEqual([]);
  });

  it("can make a closed market a blocker", async () => {
    const client = { readContract: async (a: any) => (a.functionName === "tokenPauseManager" ? ONDO_INFRA.tokenPauseManager : false) };
    const r = await checkOndoTradable(client as never, [AAPL], { marketOpen: false, blockWhenClosed: true });
    expect(r.blockers.map((b) => b.reason)).toEqual(["market-closed"]);
  });
});

describe("applySlippage and execution planning", () => {
  it("applies slippage in both directions", () => {
    expect(applySlippage({ mode: "exactIn", amountIn: 100n, amountOut: 1000n }, 50)).toEqual({ amountOutMin: 995n, amountInMax: 100n });
    expect(applySlippage({ mode: "exactOut", amountIn: 1000n, amountOut: 5n }, 100)).toEqual({ amountOutMin: 5n, amountInMax: 1010n });
    expect(() => applySlippage({ mode: "exactIn", amountIn: 1n, amountOut: 1n }, 10_000)).toThrow(RangeError);
    expect(() => applySlippage({ mode: "exactIn", amountIn: 1n, amountOut: 1n }, -1)).toThrow(RangeError);
  });

  it("plans approvals for an ERC-20 pay asset and builds the transaction with the signed permit", async () => {
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: WETH, amount: 10n ** 18n, slippageBps: 50 });
    const plan = await planExecution(mockClient(world) as never, q, { account: USDC.address, now: 1_800_000_000 });
    expect(plan.native).toBe(false);
    expect(plan.approval).toMatchObject({ needsApprove: true, needsPermit: true });
    expect(plan.approveTx?.to).toBe(weth);
    expect(plan.permit?.details.amount).toBe(10n ** 18n);
    expect(plan.typedData?.primaryType).toBe("PermitSingle");
    const tx = buildTradeTransaction(q, { deadline: 1_800_001_200, signedPermit: { permit: plan.permit!, signature: `0x${"11".repeat(65)}` } });
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith("0x3593564c")).toBe(true); // execute(bytes,bytes[],uint256)
  });

  it("needs no approvals when paying in ETH and sends the amount as value", async () => {
    world.rate = (id) => (id === tokenId ? 1000 : 1);
    const q = await quoteTrade(mockClient(world) as never, { token, side: "buy", asset: { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 }, amount: 10n ** 18n, slippageBps: 50 });
    const plan = await planExecution(mockClient(world) as never, q, { account: USDC.address });
    expect(plan).toMatchObject({ native: true, approveTx: null, permit: null });
    expect(buildTradeTransaction(q).value).toBe(10n ** 18n);
  });
});
