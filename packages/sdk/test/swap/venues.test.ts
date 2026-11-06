import { decodeAbiParameters, decodeFunctionData, getAddress, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTRACT_BALANCE,
  DEFAULT_ENVIRONMENT,
  KNOWN_ERROR_SELECTORS,
  NATIVE_CURRENCY,
  ROUTER_ADDRESS_THIS,
  ROUTER_MSG_SENDER,
  SwapError,
  UR_COMMAND,
  USDC,
  V4_ACTION,
  WETH,
  buildSwapCalldata,
  candidatePairs,
  clearDiscoveryCache,
  discoverPools,
  discoverV2Pairs,
  discoverV3Pools,
  enumerateRoutes,
  estimateRoute,
  isqrt,
  mapSwapError,
  movingCurrencies,
  ONDO_TOKENS,
  poolIdOf,
  quoteRoute,
  quoteTrade,
  routeVenues,
  segmentRoute,
  universalRouterAbi,
  v2Path,
  v3Path,
  varadaPoolKey,
  type PoolState,
  type Route,
  type VaradaMarketToken,
} from "../../src/index.js";
import { HOOK, TOKEN, fakePool } from "./helpers.js";

const weth = WETH.address;
const usdc = USDC.address;
const V3_POOL = getAddress("0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8");
const V2_PAIR = getAddress("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc");
const sorted = (a: Address, b: Address): [Address, Address] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

/** A v3 pool as the routing layer sees it (same shape `discoverV3Pools` returns). */
function v3Pool(a: Address, b: Address, fee: number, liquidity: bigint, address: Address = V3_POOL, sqrtPriceX96 = 2n ** 96n): PoolState {
  const base = fakePool(a, b, fee, 0, liquidity, { sqrtPriceX96 });
  return { ...base, venue: "v3", address, poolId: address.toLowerCase() as Hex, lpFee: fee };
}
function v2Pair(a: Address, b: Address, liquidity: bigint, address: Address = V2_PAIR): PoolState {
  const base = fakePool(a, b, 3000, 0, liquidity);
  return { ...base, venue: "v2", address, poolId: address.toLowerCase() as Hex, lpFee: 3000 };
}

const tokenPool = fakePool(TOKEN, weth, 0x800000, 200, 10n ** 18n, { hooks: HOOK });

describe("helpers", () => {
  it("isqrt is the floor square root", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(15n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(10n ** 40n + 1n)).toBe(10n ** 20n);
  });

  it("folds native ETH into WETH and honours the core set", () => {
    const pairs = candidatePairs([NATIVE_CURRENCY, weth, usdc, TOKEN], weth);
    expect(pairs).toHaveLength(3); // WETH/USDC, WETH/TOKEN, USDC/TOKEN
    const core = candidatePairs([TOKEN, usdc, weth], weth, [weth]);
    expect(core.map((p) => p.map((a) => a.toLowerCase()).sort().join("/"))).toHaveLength(2); // no USDC/TOKEN
  });

  it("packs a v3 path forward for exact-in and reversed for exact-out", () => {
    const [r] = enumerateRoutes([v3Pool(usdc, weth, 500, 10n), v3Pool(weth, TOKEN, 3000, 10n, getAddress("0x1111111111111111111111111111111111111112"))], usdc, TOKEN, { weth });
    const steps = r!.steps.filter((s) => s.kind === "pool") as never[];
    const fwd = v3Path(steps, "exactIn");
    expect(fwd).toBe(`0x${usdc.slice(2)}${(500).toString(16).padStart(6, "0")}${weth.slice(2)}${(3000).toString(16).padStart(6, "0")}${TOKEN.slice(2)}`.toLowerCase());
    const rev = v3Path(steps, "exactOut");
    expect(rev).toBe(`0x${TOKEN.slice(2)}${(3000).toString(16).padStart(6, "0")}${weth.slice(2)}${(500).toString(16).padStart(6, "0")}${usdc.slice(2)}`.toLowerCase());
    expect(v2Path(steps).map((a) => a.toLowerCase())).toEqual([usdc, weth, TOKEN].map((a) => a.toLowerCase()));
  });
});

describe("discovery of v3 pools and v2 pairs", () => {
  it("reads getPool then slot0 / liquidity and builds states", async () => {
    const calls: string[] = [];
    const client = {
      async readContract(a: { functionName: string; address: string; args?: readonly unknown[] }) {
        calls.push(a.functionName);
        if (a.functionName === "getPool") return a.args![2] === 500 ? V3_POOL : "0x0000000000000000000000000000000000000000";
        if (a.functionName === "slot0") return [2n ** 96n, 7, 0, 1, 1, 0, true];
        if (a.functionName === "liquidity") return 12_345n;
        throw new Error("unexpected " + a.functionName);
      },
    };
    const states = await discoverV3Pools(client as never, [[weth, usdc]]);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ venue: "v3", address: V3_POOL, poolId: V3_POOL.toLowerCase(), lpFee: 500, liquidity: 12_345n, tick: 7, initialized: true });
    expect(states[0]!.key.fee).toBe(500);
    expect([states[0]!.key.currency0, states[0]!.key.currency1]).toEqual(sorted(weth, usdc));
    expect(calls.filter((c) => c === "getPool")).toHaveLength(4); // the four fee tiers
  });

  it("treats failed or empty reads as no pools", async () => {
    const dead = { async readContract() { throw new Error("execution reverted"); } };
    expect(await discoverV3Pools(dead as never, [[weth, usdc]])).toEqual([]);
    expect(await discoverV2Pairs(dead as never, [[weth, usdc]])).toEqual([]);
  });

  it("turns v2 reserves into constant-product state: virtual reserves recover the real ones", async () => {
    const [t0] = sorted(weth, usdc);
    const r0 = 4_000n * 10n ** (t0 === weth ? 18n : 6n);
    const r1 = 9_000_000n * 10n ** (t0 === weth ? 6n : 18n);
    const client = {
      async readContract(a: { functionName: string }) {
        if (a.functionName === "getPair") return V2_PAIR;
        if (a.functionName === "getReserves") return [r0, r1, 1];
        throw new Error("unexpected");
      },
    };
    const [st] = await discoverV2Pairs(client as never, [[weth, usdc]]);
    expect(st).toMatchObject({ venue: "v2", lpFee: 3000, initialized: true });
    // estimateRoute treats the pool as L / sqrtP, L * sqrtP reserves
    const [r] = enumerateRoutes([st!], t0, t0 === weth ? usdc : weth, { weth });
    const out = estimateRoute(r!, new Map([[st!.poolId, st!]]), 10n ** 6n, "exactIn")!;
    const exact = Number((r1 * 997n * 10n ** 6n) / (r0 * 1000n + 997n * 10n ** 6n));
    expect(Math.abs(out - exact) / exact).toBeLessThan(1e-9);
  });

  it("discoverPools merges the venues and skips v3 / v2 when switched off", async () => {
    clearDiscoveryCache();
    const client = {
      async readContract(a: { functionName: string; args?: readonly unknown[] }) {
        switch (a.functionName) {
          case "getSlot0":
            return [0n, 0, 0, 0];
          case "getLiquidity":
            return 0n;
          case "getPool":
            return a.args![2] === 500 ? V3_POOL : "0x0000000000000000000000000000000000000000";
          case "getPair":
            return V2_PAIR;
          case "slot0":
            return [2n ** 96n, 0, 0, 1, 1, 0, true];
          case "liquidity":
            return 99n;
          case "getReserves":
            return [10n ** 18n, 10n ** 18n, 1];
          default:
            throw new Error("unexpected " + a.functionName);
        }
      },
    };
    const all = await discoverPools(client as never, [weth, usdc]);
    expect(all.map((p) => p.venue ?? "v4").sort()).toEqual(["v2", "v3"]);
    clearDiscoveryCache();
    expect(await discoverPools(client as never, [weth, usdc], { venues: { v3: false, v2: false } })).toEqual([]);
    clearDiscoveryCache();
    expect((await discoverPools(client as never, [weth, usdc], { venues: { v2: false } })).map((p) => p.venue)).toEqual(["v3"]);
  });
});

describe("routes across venues", () => {
  const usdcWeth3 = v3Pool(usdc, weth, 500, 10n ** 15n);
  const usdcWeth2 = v2Pair(usdc, weth, 10n ** 12n, getAddress("0x2222222222222222222222222222222222222223"));

  it("finds a v3 route from USDC into a v4 Varada token and splits it by venue", () => {
    const routes = enumerateRoutes([tokenPool, usdcWeth3], usdc, TOKEN, { weth });
    expect(routes).toHaveLength(1);
    const r = routes[0]!;
    expect(routeVenues(r)).toEqual(["v3", "v4"]);
    const segs = segmentRoute(r);
    expect(segs.map((s) => s.kind)).toEqual(["v3", "v4"]);
    expect(movingCurrencies(r).map((a) => a.toLowerCase()).sort()).toEqual([usdc, weth, TOKEN].map((a) => a.toLowerCase()).sort());
  });

  it("enumerates the same pair on several venues as separate routes", () => {
    const routes = enumerateRoutes([tokenPool, usdcWeth3, usdcWeth2], usdc, TOKEN, { weth });
    expect(routes.map((r) => routeVenues(r).join("+")).sort()).toEqual(["v2+v4", "v3+v4"]);
  });

  it("merges consecutive steps of one venue into one segment", () => {
    const wethTok3 = v3Pool(weth, TOKEN, 3000, 10n ** 15n, getAddress("0x3333333333333333333333333333333333333334"));
    const [r] = enumerateRoutes([usdcWeth3, wethTok3], usdc, TOKEN, { weth });
    const segs = segmentRoute(r!);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("v3");
    expect(segs[0]!.kind === "v3" && segs[0]!.steps).toHaveLength(2);
  });

  it("reaches a v3 pool from native ETH through the wrap edge", () => {
    const [r] = enumerateRoutes([usdcWeth3], NATIVE_CURRENCY, usdc, { weth });
    expect(r!.steps.map((s) => s.kind)).toEqual(["wrap", "pool"]);
    expect(segmentRoute(r!).map((s) => s.kind)).toEqual(["wrap", "v3"]);
  });

  it("a v4 intermediate Ondo hop does not move, a v3 / v2 hop does", () => {
    const aapl = ONDO_TOKENS.AAPLon.address;
    const v4Mid = enumerateRoutes([fakePool(weth, aapl, 10_000, 200, 10n ** 15n), fakePool(aapl, usdc, 10_000, 200, 10n ** 15n)], weth, usdc, { weth });
    expect(movingCurrencies(v4Mid[0]!).map((a) => a.toLowerCase())).not.toContain(aapl.toLowerCase());
    const v3Mid = enumerateRoutes([v3Pool(weth, aapl, 10_000, 10n ** 15n), v3Pool(aapl, usdc, 10_000, 10n ** 15n, getAddress("0x4444444444444444444444444444444444444445"))], weth, usdc, { weth });
    expect(movingCurrencies(v3Mid[0]!).map((a) => a.toLowerCase())).toContain(aapl.toLowerCase());
  });
});

// ---- calldata

function decode(data: Hex) {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data });
  const [commands, inputs] = args as [Hex, Hex[], bigint];
  return { commands: [...hexToBytes(commands)], inputs };
}
const packedV3 = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }] as const;
const packedV2 = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address[]" }, { type: "bool" }] as const;
const deadline = 1_900_000_000;

describe("buildSwapCalldata with v3 and v2", () => {
  const usdcWeth3 = v3Pool(usdc, weth, 500, 10n ** 15n);
  const usdcWeth2 = v2Pair(usdc, weth, 10n ** 12n);
  const find = (pools: PoolState[], from: Address, to: Address): Route => enumerateRoutes(pools, from, to, { weth })[0]!;

  it("ERC-20 in, one v3 hop: V3_SWAP_EXACT_IN paid by the user, output to the sender", () => {
    const r = find([usdcWeth3], usdc, weth);
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 1_000_000n, amountOut: 77n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V3_SWAP_EXACT_IN]);
    const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(packedV3, inputs[0]!);
    expect([recipient, amountIn, minOut, payerIsUser]).toEqual([ROUTER_MSG_SENDER, 1_000_000n, 77n, true]);
    expect(path).toBe(`0x${usdc.slice(2)}0001f4${weth.slice(2)}`.toLowerCase());
    expect(tx.value).toBe(0n);
  });

  it("native ETH into a v3 pool: WRAP_ETH then V3_SWAP_EXACT_IN spending the router's WETH", () => {
    const r = find([usdcWeth3], NATIVE_CURRENCY, usdc);
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 10n ** 18n, amountOut: 5n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.WRAP_ETH, UR_COMMAND.V3_SWAP_EXACT_IN]);
    expect(tx.value).toBe(10n ** 18n);
    const [recipient, amountIn, minOut, , payerIsUser] = decodeAbiParameters(packedV3, inputs[1]!);
    expect([recipient, amountIn, minOut, payerIsUser]).toEqual([ROUTER_MSG_SENDER, CONTRACT_BALANCE, 5n, false]);
  });

  it("v3 into v4: the first leg keeps the output in the router, the v4 leg settles its balance", () => {
    const tokenKey = varadaPoolKey(TOKEN, weth, HOOK);
    expect(poolIdOf(tokenKey)).toBe(tokenPool.poolId);
    const r = find([tokenPool, usdcWeth3], usdc, TOKEN);
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 2_000_000n, amountOut: 9n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V3_SWAP_EXACT_IN, UR_COMMAND.V4_SWAP]);
    const [recipient, amountIn, minOut, , payerIsUser] = decodeAbiParameters(packedV3, inputs[0]!);
    expect([recipient, amountIn, minOut, payerIsUser]).toEqual([ROUTER_ADDRESS_THIS, 2_000_000n, 0n, true]);
    const [actions] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[1]!);
    expect([...hexToBytes(actions)]).toEqual([V4_ACTION.SETTLE, V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.TAKE_ALL]);
  });

  it("v4 into v2: the v4 leg takes to the router, the v2 leg spends the router balance for the sender", () => {
    const aapl = ONDO_TOKENS.AAPLon.address;
    const v4Leg = fakePool(NATIVE_CURRENCY, usdc, 500, 10, 10n ** 15n);
    const v2Leg = v2Pair(usdc, aapl, 10n ** 12n, getAddress("0x5555555555555555555555555555555555555556"));
    const r = find([v4Leg, v2Leg], NATIVE_CURRENCY, aapl);
    expect(segmentRoute(r).map((s) => s.kind)).toEqual(["v4", "v2"]);
    const tx = buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 10n ** 18n, amountOut: 3n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.V4_SWAP, UR_COMMAND.V2_SWAP_EXACT_IN]);
    const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(packedV2, inputs[1]!);
    expect([recipient, amountIn, minOut, payerIsUser]).toEqual([ROUTER_MSG_SENDER, CONTRACT_BALANCE, 3n, false]);
    expect((path as Address[]).map((a) => a.toLowerCase())).toEqual([usdc, aapl].map((a) => a.toLowerCase()));
    expect(tx.value).toBe(10n ** 18n);
  });

  it("v2 hop into an unwrap: output stays in the router and UNWRAP_WETH enforces the minimum", () => {
    const r = find([usdcWeth2], usdc, NATIVE_CURRENCY);
    const { commands, inputs } = decode(buildSwapCalldata({ route: r, mode: "exactIn", amountIn: 5_000_000n, amountOut: 11n, deadline }).data);
    expect(commands).toEqual([UR_COMMAND.V2_SWAP_EXACT_IN, UR_COMMAND.UNWRAP_WETH]);
    expect(decodeAbiParameters(packedV2, inputs[0]!)[0]).toBe(ROUTER_ADDRESS_THIS);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[1]!)).toEqual([ROUTER_MSG_SENDER, 11n]);
  });

  it("exact-out: single v3 path reversed, paid by the user", () => {
    const r = find([usdcWeth3], usdc, weth);
    const { commands, inputs } = decode(buildSwapCalldata({ route: r, mode: "exactOut", amountIn: 3_000_000n, amountOut: 10n ** 15n, deadline }).data);
    expect(commands).toEqual([UR_COMMAND.V3_SWAP_EXACT_OUT]);
    const [recipient, out, maxIn, path, payerIsUser] = decodeAbiParameters(packedV3, inputs[0]!);
    expect([recipient, out, maxIn, payerIsUser]).toEqual([ROUTER_MSG_SENDER, 10n ** 15n, 3_000_000n, true]);
    expect(path).toBe(`0x${weth.slice(2)}0001f4${usdc.slice(2)}`.toLowerCase());
  });

  it("exact-out paid in ETH through a wrap on v2 refunds the leftover as ETH", () => {
    const r = find([usdcWeth2], NATIVE_CURRENCY, usdc);
    const tx = buildSwapCalldata({ route: r, mode: "exactOut", amountIn: 2n * 10n ** 18n, amountOut: 1_000_000n, deadline });
    const { commands, inputs } = decode(tx.data);
    expect(commands).toEqual([UR_COMMAND.WRAP_ETH, UR_COMMAND.V2_SWAP_EXACT_OUT, UR_COMMAND.UNWRAP_WETH]);
    expect(tx.value).toBe(2n * 10n ** 18n);
    const [recipient, out, maxIn, , payerIsUser] = decodeAbiParameters(packedV2, inputs[1]!);
    expect([recipient, out, maxIn, payerIsUser]).toEqual([ROUTER_MSG_SENDER, 1_000_000n, 2n * 10n ** 18n, false]);
  });

  it("exact-out across venues is unsupported", () => {
    const r = find([tokenPool, usdcWeth3], usdc, TOKEN);
    expect(() => buildSwapCalldata({ route: r, mode: "exactOut", amountIn: 1n, amountOut: 1n, deadline })).toThrow(SwapError);
  });
});

// ---- quotes

describe("quoteRoute across venues", () => {
  it("uses QuoterV2 for v3, getAmountsOut for v2 and sums the gas", async () => {
    const usdcWeth3 = v3Pool(usdc, weth, 500, 10n ** 15n);
    const wethTok2 = v2Pair(weth, TOKEN, 10n ** 15n, getAddress("0x6666666666666666666666666666666666666667"));
    const [route] = enumerateRoutes([usdcWeth3, wethTok2], usdc, TOKEN, { weth });
    const seen: string[] = [];
    const client = {
      async readContract(a: { functionName: string; address: string; args: readonly unknown[] }) {
        seen.push(`${a.functionName}@${a.address}`);
        if (a.functionName === "quoteExactInput") return [5_000n, [], [], 150_000n];
        if (a.functionName === "quoteExactOutput") return [7_000n, [], [], 160_000n];
        if (a.functionName === "getAmountsOut") return [a.args[0], 4_000n];
        if (a.functionName === "getAmountsIn") return [6_000n, a.args[0]];
        throw new Error("unexpected " + a.functionName);
      },
    };
    const states = new Map([usdcWeth3, wethTok2].map((p) => [p.poolId, p] as const));
    const ctx = { tokenIn: USDC, tokenOut: { address: TOKEN, symbol: "T", decimals: 18 }, states };
    const q = await quoteRoute(client as never, route!, "exactIn", 1_000_000n, ctx);
    expect(q.amountOut).toBe(4_000n);
    expect(q.gasEstimate).toBe(150_000n + 110_000n);
    expect(seen).toEqual([`quoteExactInput@${DEFAULT_ENVIRONMENT.v3Quoter}`, `getAmountsOut@${DEFAULT_ENVIRONMENT.v2Router}`]);
    expect(q.totalFeePct).toBeCloseTo((1 - 0.9995 * 0.997) * 100, 8);
    const out = await quoteRoute(client as never, route!, "exactOut", 4_000n, ctx);
    expect(out.amountIn).toBe(7_000n);
  });
});

// ---- engine

describe("quoteTrade with a v3 leg", () => {
  const token: VaradaMarketToken = { address: TOKEN, symbol: "TKN", hook: HOOK, quote: WETH };
  const tokenId = poolIdOf(varadaPoolKey(TOKEN, weth, HOOK));
  const aapl = ONDO_TOKENS.AAPLon.address;
  beforeEach(() => clearDiscoveryCache());

  function chain() {
    return {
      async readContract(a: { functionName: string; address: string; args?: readonly unknown[] }) {
        const args = (a.args ?? []) as any[];
        switch (a.functionName) {
          case "getSlot0":
            return args[0] === tokenId ? [2n ** 96n, 0, 0, 0] : [0n, 0, 0, 0];
          case "getLiquidity":
            return args[0] === tokenId ? 10n ** 18n : 0n;
          case "getPool": {
            const pair = [String(args[0]).toLowerCase(), String(args[1]).toLowerCase()].sort().join("/");
            return pair === [usdc, weth].map((x) => x.toLowerCase()).sort().join("/") && args[2] === 500 ? V3_POOL : "0x0000000000000000000000000000000000000000";
          }
          case "getPair":
            return "0x0000000000000000000000000000000000000000";
          case "slot0":
            return [2n ** 96n, 0, 0, 1, 1, 0, true];
          case "liquidity":
            return 10n ** 18n;
          case "quoteExactInput":
            if (a.address === DEFAULT_ENVIRONMENT.v3Quoter) return [2_000n, [], [], 120_000n];
            throw new Error("unexpected quoter");
          case "quoteExactInputSingle":
            return [1_000n * 10n ** 15n, 90_000n];
          case "currentFeeBps":
            return 300;
          case "feeConfig":
            return { baseFeeBps: 100, surchargeStartBps: 4000, decaySeconds: 600, launchTimestamp: 1 };
          case "vault":
            throw new Error("execution reverted");
          case "tokenPauseManager":
            return "0x0000000000000000000000000000000000000abc";
          case "isTokenPaused":
            return false;
          case "allTokensPaused":
            return false;
          default:
            throw new Error("unexpected call " + a.functionName);
        }
      },
    };
  }

  it("buys a Varada token paying USDC when the only USDC/WETH liquidity is on v3", async () => {
    const q = await quoteTrade(chain() as never, { token, side: "buy", asset: USDC, amount: 1_000_000n, slippageBps: 50 }, { routing: { venues: { v2: true } } });
    expect(q.venues).toEqual(["v3", "v4"]);
    expect(q.routeLabel).toBe("USDC > WETH > TKN");
    expect(q.amountOut).toBe(1_000n * 10n ** 15n);
    expect(q.best.route.steps.map((s) => (s.kind === "pool" ? (s.venue ?? "v4") : s.kind))).toEqual(["v3", "v4"]);
    expect(q.blockers).toEqual([]);
  });

  it("with v3 and v2 switched off the same trade has no route (v4-only behaviour)", async () => {
    await expect(quoteTrade(chain() as never, { token, side: "buy", asset: USDC, amount: 1_000_000n, slippageBps: 50 }, { routing: { venues: { v3: false, v2: false } } })).rejects.toMatchObject({ reason: "no-route" });
  });

  it("counts an Ondo token between two v3 pools as moving (so its pause blocks)", () => {
    const r = enumerateRoutes([v3Pool(usdc, aapl, 10_000, 10n), v3Pool(aapl, weth, 10_000, 10n, getAddress("0x7777777777777777777777777777777777777778")), tokenPool], usdc, TOKEN, { weth })[0]!;
    expect(movingCurrencies(r).map((a) => a.toLowerCase())).toContain(aapl.toLowerCase());
  });
});

describe("error selectors of v3 and v2", () => {
  it("names the Universal Router v3 / v2 errors", () => {
    const sel = (sig: string) => keccak256(toHex(sig)).slice(0, 10);
    for (const [sig, reason] of [
      ["V3TooLittleReceived()", "slippage"],
      ["V3TooMuchRequested()", "slippage"],
      ["V2TooLittleReceived()", "slippage"],
      ["V2TooMuchRequested()", "slippage"],
      ["V2InvalidPath()", "no-route"],
    ] as const) {
      expect(KNOWN_ERROR_SELECTORS[sel(sig)]).toBe(reason);
    }
    expect(mapSwapError(new Error("execution reverted: UniswapV2Library: INSUFFICIENT_LIQUIDITY")).reason).toBe("insufficient-liquidity");
  });
});
