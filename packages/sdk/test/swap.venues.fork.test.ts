/**
 * Mainnet-fork tests of the Uniswap v3 and v2 venues: real v3 / v2 pools, the real QuoterV2, Router02 and
 * Universal Router. Quote equals execution is asserted from balance deltas after real transactions.
 *
 * Skipped unless FORK_RPC_URL points at an anvil fork of mainnet (chain id 1), see docs/SWAP.md:
 *   anvil --fork-url https://ethereum.reth.rs/rpc --fork-block-number <recent block> --chain-id 1 --port <port> --code-size-limit 100000
 *   FORK_RPC_URL=http://127.0.0.1:<port> pnpm --filter @varada/sdk exec vitest run test/swap.venues.fork.test.ts
 * The mixed v3 + v4 case into a Varada token also needs contracts/deployments/swap-fork.json (SwapForkFixture.s.sol).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseEther, toHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAI,
  ETH,
  EXTERNAL_ADDRESSES,
  ONDO_TOKENS,
  USDC,
  WETH,
  applySlippage,
  buildSwapCalldata,
  buildTradeTransaction,
  checkOndoTradable,
  clearDiscoveryCache,
  discoverPools,
  enumerateRoutes,
  erc20Abi,
  movingCurrencies,
  permit2Abi,
  permitSingleTypedData,
  pickBestQuote,
  planExecution,
  quoteTrade,
  rankRoutes,
  routeVenues,
  routingNodes,
  segmentRoute,
  type RouteQuote,
  type RoutingConfig,
  type SwapAsset,
  type VaradaMarketToken,
} from "../src/index.js";

const RPC = process.env.FORK_RPC_URL;
const describeFork = RPC ? describe : describe.skip;
const fixturePath = resolve(__dirname, process.env.SWAP_FORK_FIXTURE_JSON ?? "../../../contracts/deployments/swap-fork.json");
const fixture = existsSync(fixturePath) ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, Address>) : null;
const describeVarada = RPC && fixture ? describe : describe.skip;

// A fresh key: the anvil dev accounts are EIP-7702 delegated on mainnet (see docs/SWAP.md).
const trader = privateKeyToAccount(keccak256(toHex("varada swap venues fork test trader")));
const transport = http(RPC ?? "http://127.0.0.1:8546", { timeout: 180_000 });
const client = createPublicClient({ chain: mainnet, transport }) as PublicClient;
const wallet = createWalletClient({ account: trader, chain: mainnet, transport });
const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport });
const weth = WETH.address;

const NVDA: SwapAsset = { address: ONDO_TOKENS.NVDAon.address, symbol: "NVDAon", decimals: 18 };
const ONLY_V3: RoutingConfig = { venues: { v4: false, v3: true, v2: false } };
const ONLY_V2: RoutingConfig = { venues: { v4: false, v3: false, v2: true } };
const ONLY_V4: RoutingConfig = { venues: { v4: true, v3: false, v2: false } };

const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(`[fork] ${s}`);
};

beforeEach(() => clearDiscoveryCache());

const balanceOf = (asset: Address, who: Address = trader.address): Promise<bigint> =>
  asset === ETH.address ? client.getBalance({ address: who }) : client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function quote(from: SwapAsset, to: SwapAsset, amount: bigint, mode: "exactIn" | "exactOut", routing: RoutingConfig, extraNodes: Address[] = []) {
  clearDiscoveryCache();
  const nodes = routingNodes(routing, [from.address, to.address, ...extraNodes]);
  const pools = await discoverPools(client, nodes, routing);
  const states = new Map(pools.map((p) => [p.poolId, p]));
  const candidates = enumerateRoutes(pools, from.address, to.address, { weth, maxCandidates: 16 });
  const ranked = rankRoutes(candidates, states, amount, mode, 4);
  const picked = await pickBestQuote(client, ranked, mode, amount, { tokenIn: from, tokenOut: to, states });
  return { ...picked, candidates, pools };
}

let approved = new Set<string>();
/** Executes a quote through the Universal Router with a Permit2 permit for ERC-20 inputs. Returns the pay and receive deltas (ETH net of gas added back). */
async function execute(from: SwapAsset, to: SwapAsset, q: RouteQuote, slippageBps = 50) {
  const limits = applySlippage(q, slippageBps);
  const now = Number((await client.getBlock()).timestamp);
  const spend = q.mode === "exactIn" ? q.amountIn : limits.amountInMax;
  let permit;
  if (from.address !== ETH.address) {
    if (!approved.has(from.address)) {
      const h = await wallet.sendTransaction({ to: from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [EXTERNAL_ADDRESSES.permit2, 2n ** 256n - 1n] }) });
      await client.waitForTransactionReceipt({ hash: h });
      approved.add(from.address);
    }
    const [, , nonce] = await client.readContract({ address: EXTERNAL_ADDRESSES.permit2, abi: permit2Abi, functionName: "allowance", args: [trader.address, from.address, EXTERNAL_ADDRESSES.universalRouter] });
    const p = { details: { token: from.address, amount: spend, expiration: now + 1800, nonce: Number(nonce) }, spender: EXTERNAL_ADDRESSES.universalRouter, sigDeadline: BigInt(now + 1800) };
    permit = { permit: p, signature: await trader.signTypedData({ ...permitSingleTypedData(p, EXTERNAL_ADDRESSES.permit2, 1), message: p }) };
  }
  const tx = buildSwapCalldata({ route: q.route, mode: q.mode, amountIn: spend, amountOut: q.mode === "exactIn" ? limits.amountOutMin : q.amountOut, deadline: now + 600, permit });
  const [payBefore, outBefore] = await Promise.all([balanceOf(from.address), balanceOf(to.address)]);
  const hash = await wallet.sendTransaction({ ...tx, gas: 2_000_000n });
  const rc = await client.waitForTransactionReceipt({ hash });
  expect(rc.status).toBe("success");
  const gasCost = rc.gasUsed * rc.effectiveGasPrice;
  const paid = payBefore - (await balanceOf(from.address)) - (from.address === ETH.address ? gasCost : 0n);
  const got = (await balanceOf(to.address)) - outBefore + (to.address === ETH.address ? gasCost : 0n);
  return { paid, got, gas: rc.gasUsed };
}

describeFork("Uniswap v3 and v2 venues on the fork", () => {
  beforeAll(async () => {
    expect(await client.getChainId()).toBe(1);
    await testClient.setBalance({ address: trader.address, value: parseEther("100000") });
  });

  it("discovers the real v3 and v2 pools (ETH/USDC, an Ondo stock)", async () => {
    clearDiscoveryCache();
    const pools = await discoverPools(client, routingNodes({}, [ETH.address, USDC.address, NVDA.address]));
    const v3 = pools.filter((p) => p.venue === "v3");
    const v2 = pools.filter((p) => p.venue === "v2");
    expect(v3.some((p) => p.key.fee === 500 && [p.key.currency0, p.key.currency1].includes(weth) && [p.key.currency0, p.key.currency1].includes(USDC.address))).toBe(true);
    expect(v2.some((p) => [p.key.currency0, p.key.currency1].includes(weth) && [p.key.currency0, p.key.currency1].includes(USDC.address))).toBe(true);
    expect(v3.some((p) => [p.key.currency0, p.key.currency1].includes(NVDA.address))).toBe(true);
    note(`pools: ${pools.filter((p) => (p.venue ?? "v4") === "v4").length} v4, ${v3.length} v3, ${v2.length} v2 among ETH/WETH/USDC/NVDAon + hubs`);
  });

  it("ETH -> USDC on v3 only: quote equals execution; then USDC -> ETH with a Permit2 permit", async () => {
    const amount = parseEther("1");
    const q = await quote(ETH, USDC, amount, "exactIn", ONLY_V3);
    expect(routeVenues(q.best.route)).toEqual(["v3"]);
    const r = await execute(ETH, USDC, q.best);
    note(`ETH->USDC v3: quoted ${formatUnits(q.best.amountOut, 6)} executed ${formatUnits(r.got, 6)} USDC, mid ${q.best.midPrice.toFixed(2)}, impact ${q.best.priceImpactPct.toFixed(4)}%, gas ${r.gas}`);
    expect(r.paid).toBe(amount);
    expect(r.got).toBe(q.best.amountOut);
    expect(q.best.priceImpactPct).toBeLessThan(0.5);

    const sellIn = r.got / 2n;
    const back = await quote(USDC, ETH, sellIn, "exactIn", ONLY_V3);
    const r2 = await execute(USDC, ETH, back.best);
    note(`USDC->ETH v3: quoted ${formatUnits(back.best.amountOut, 18)} executed ${formatUnits(r2.got, 18)} ETH`);
    expect(r2.paid).toBe(sellIn);
    expect(r2.got).toBe(back.best.amountOut);
  });

  it("ETH -> USDC on v2 only: quote equals execution", async () => {
    const amount = parseEther("0.5");
    const q = await quote(ETH, USDC, amount, "exactIn", ONLY_V2);
    expect(routeVenues(q.best.route)).toEqual(["v2"]);
    const r = await execute(ETH, USDC, q.best);
    note(`ETH->USDC v2: quoted ${formatUnits(q.best.amountOut, 6)} executed ${formatUnits(r.got, 6)} USDC, impact ${q.best.priceImpactPct.toFixed(4)}%, gas ${r.gas}`);
    expect(r.got).toBe(q.best.amountOut);
  });

  it("all venues: the best route is at least as good as each venue alone", async () => {
    const amount = parseEther("2");
    const all = await quote(ETH, USDC, amount, "exactIn", {});
    const v4 = await quote(ETH, USDC, amount, "exactIn", ONLY_V4);
    const v3 = await quote(ETH, USDC, amount, "exactIn", ONLY_V3);
    const v2 = await quote(ETH, USDC, amount, "exactIn", ONLY_V2);
    note(`2 ETH -> USDC: all ${formatUnits(all.best.amountOut, 6)} [${routeVenues(all.best.route)}], v4 ${formatUnits(v4.best.amountOut, 6)}, v3 ${formatUnits(v3.best.amountOut, 6)}, v2 ${formatUnits(v2.best.amountOut, 6)}`);
    for (const x of [v4, v3, v2]) expect(all.best.amountOut).toBeGreaterThanOrEqual(x.best.amountOut - x.best.amountOut / 10_000n); // the estimate can rank a 1 bp worse route first
    const r = await execute(ETH, USDC, all.best);
    expect(r.got).toBe(all.best.amountOut);
  });

  it("USDC -> an Ondo stock whose liquidity is on v3 (NVDAon), quote equals execution", async () => {
    const amount = 2_000_000n; // 2 USDC
    const q = await quote(USDC, NVDA, amount, "exactIn", {});
    note(`USDC->NVDAon: route ${q.best.route.steps.map((s) => (s.kind === "pool" ? `${s.venue ?? "v4"}/${s.key.fee}` : s.kind)).join(" > ")}, quoted ${formatUnits(q.best.amountOut, 18)}, impact ${q.best.priceImpactPct.toFixed(3)}%`);
    expect(routeVenues(q.best.route)).toContain("v3");
    expect(q.best.amountOut).toBeGreaterThan(0n);
    const report = await checkOndoTradable(client, movingCurrencies(q.best.route));
    expect(report.blockers).toEqual([]);
    expect(report.checked.map((a) => a.toLowerCase())).toContain(NVDA.address.toLowerCase());
    const r = await execute(USDC, NVDA, q.best);
    note(`  executed ${formatUnits(r.got, 18)} NVDAon, gas ${r.gas}`);
    expect(r.paid).toBe(amount);
    expect(r.got).toBe(q.best.amountOut);

    // and back: NVDAon -> USDC through the same pool
    const back = await quote(NVDA, USDC, r.got, "exactIn", {});
    const r2 = await execute(NVDA, USDC, back.best);
    note(`  NVDAon->USDC: quoted ${formatUnits(back.best.amountOut, 6)} executed ${formatUnits(r2.got, 6)} USDC`);
    expect(r2.got).toBe(back.best.amountOut);
  });

  it("ETH -> NVDAon: wrap, then v3 hops (multi-hop through USDC or WETH), quote equals execution", async () => {
    const amount = parseEther("0.01");
    const q = await quote(ETH, NVDA, amount, "exactIn", ONLY_V3);
    note(`ETH->NVDAon v3: ${q.best.route.steps.map((s) => (s.kind === "pool" ? `${s.venue}/${s.key.fee}` : s.kind)).join(" > ")}, ${formatUnits(q.best.amountOut, 18)} NVDAon`);
    expect(segmentRoute(q.best.route).map((s) => s.kind)).toEqual(["wrap", "v3"]);
    const r = await execute(ETH, NVDA, q.best);
    expect(r.got).toBe(q.best.amountOut);
  });

  it("mixes v3 and v2 in one route (USDC -v3-> WETH -v2-> DAI): quote equals execution", async () => {
    // restrict the search to a v3 USDC/WETH pool and the v2 WETH/DAI pair
    clearDiscoveryCache();
    const cfg: RoutingConfig = { hubs: [WETH, USDC, DAI] };
    const nodes = routingNodes(cfg, [USDC.address, DAI.address]);
    const pools = (await discoverPools(client, nodes, cfg)).filter((p) => {
      const pair = [p.key.currency0, p.key.currency1];
      if (p.venue === "v3") return pair.includes(USDC.address) && pair.includes(weth);
      if (p.venue === "v2") return pair.includes(DAI.address) && pair.includes(weth);
      return false;
    });
    const states = new Map(pools.map((p) => [p.poolId, p]));
    const routes = enumerateRoutes(pools, USDC.address, DAI.address, { weth });
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(routeVenues(r)).toEqual(["v3", "v2"]);
    const amount = 50_000_000n; // 50 USDC
    const { best } = await pickBestQuote(client, routes.slice(0, 2), "exactIn", amount, { tokenIn: USDC, tokenOut: DAI, states });
    const r = await execute(USDC, DAI, best);
    note(`USDC->DAI v3+v2: quoted ${formatUnits(best.amountOut, 18)} executed ${formatUnits(r.got, 18)} DAI, gas ${r.gas}`);
    expect(r.got).toBe(best.amountOut);
  });

  it("exact-out on v3: exactly 100 USDC for ETH (wrap, swap, refund) and for DAI-free USDC input", async () => {
    const out = 100_000_000n;
    const q = await quote(ETH, USDC, out, "exactOut", ONLY_V3);
    expect(routeVenues(q.best.route)).toEqual(["v3"]);
    const r = await execute(ETH, USDC, q.best);
    note(`exact-out 100 USDC (v3, paid in ETH): quoted ${formatUnits(q.best.amountIn, 18)} ETH, spent ${formatUnits(r.paid, 18)}, received ${formatUnits(r.got, 6)}`);
    expect(r.got).toBe(out);
    expect(r.paid).toBe(q.best.amountIn);

    const q2 = await quote(USDC, ETH, parseEther("0.01"), "exactOut", ONLY_V3);
    const r2 = await execute(USDC, ETH, q2.best);
    expect(r2.got).toBe(parseEther("0.01"));
    expect(r2.paid).toBe(q2.best.amountIn);
  });

  it("exact-out on v2: exactly 50 USDC for ETH", async () => {
    const out = 50_000_000n;
    const q = await quote(ETH, USDC, out, "exactOut", ONLY_V2);
    const r = await execute(ETH, USDC, q.best);
    expect(r.got).toBe(out);
    expect(r.paid).toBe(q.best.amountIn);
  });

  it("a size that wipes out the pool shows an absurd price impact (the engine blocks it at 30%)", async () => {
    const r = await quote(ETH, NVDA, parseEther("5000"), "exactIn", ONLY_V3).catch((e) => e);
    if (r instanceof Error) expect(r).toMatchObject({ reason: expect.stringMatching(/insufficient-liquidity|unknown/) });
    else expect(r.best.priceImpactPct).toBeGreaterThan(30);
  });
});

describeVarada("mixed v3 + v4 routes into a Varada token on the fork", () => {
  const fx = (fixture ?? {}) as Record<"hook" | "weeklyWeth", Address>;
  const token: VaradaMarketToken = { address: getAddress(fx.weeklyWeth ?? "0x0000000000000000000000000000000000000001"), symbol: "SWKL", hook: fx.hook, quote: WETH };
  beforeAll(async () => {
    await testClient.setBalance({ address: trader.address, value: parseEther("100000") });
  });

  it("pays with an Ondo stock whose only pool is v3 (NVDAon > USDC on v3), the Varada pool (v4) fills the rest: quote equals execution", async () => {
    // fund NVDAon through its v3 pool
    const fund = await quote(USDC, NVDA, 20_000_000n, "exactIn", ONLY_V3, [ETH.address]);
    const bal0 = await balanceOf(USDC.address);
    if (bal0 < 20_000_000n) {
      const usdc = await quote(ETH, USDC, parseEther("1"), "exactIn", ONLY_V3);
      await execute(ETH, USDC, usdc.best);
    }
    await execute(USDC, NVDA, fund.best);
    await testClient.mine({ blocks: 1 });
    clearDiscoveryCache();
    const amount = (await balanceOf(NVDA.address)) / 2n;
    const q = await quoteTrade(client, { token, side: "buy", asset: NVDA, amount, slippageBps: 100 });
    note(`NVDAon->SWKL: ${q.routeLabel} via ${q.venues.join("+")}, ${formatUnits(q.amountOut, 18)} tokens, fee ${q.fee.feeBps} bp, gas ${q.best.gasEstimate}`);
    expect(q.venues[0]).toBe("v3");
    expect(q.venues).toContain("v4");
    expect(q.blockers).toEqual([]);
    const plan = await planExecution(client, q, { account: trader.address, chainId: 1 });
    const before = await balanceOf(token.address);
    const now = Number((await client.getBlock()).timestamp);
    if (plan.approveTx) await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction(plan.approveTx) });
    const signedPermit = plan.permit && plan.typedData ? { permit: plan.permit, signature: await trader.signTypedData({ ...plan.typedData, message: plan.permit }) } : undefined;
    const tx = buildTradeTransaction(q, { signedPermit, deadline: now + 1200 });
    const rc = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ ...tx, gas: 3_000_000n }) });
    expect(rc.status).toBe("success");
    const got = (await balanceOf(token.address)) - before;
    note(`  executed ${formatUnits(got, 18)} tokens, gas ${rc.gasUsed}`);
    // the launch surcharge decays with block time, so the next block can only be better
    expect(got).toBeGreaterThanOrEqual(q.amountOut);
    expect(got - q.amountOut).toBeLessThanOrEqual(q.amountOut / 1000n);
  });
});
