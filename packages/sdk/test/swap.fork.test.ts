/**
 * Mainnet-fork integration tests of the swap engine: real Uniswap v4 pools, the real V4Quoter and
 * Universal Router, the real Varada contracts (deployed on the fork by contracts/script/SwapForkFixture.s.sol).
 *
 * Skipped unless FORK_RPC_URL points at an anvil fork of mainnet (chain id 1). To run:
 *   anvil --fork-url https://ethereum.reth.rs/rpc --chain-id 1 --port 8546      # needs archive state
 *   cd contracts && SWAP_FORK_FIXTURE=1 PLATFORM_TREASURY=<addr> forge script script/SwapForkFixture.s.sol \
 *     --sig "fixture()" --rpc-url http://127.0.0.1:8546 --broadcast --private-key <anvil key 0>
 *   FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @varada/sdk exec vitest run test/swap.fork.test.ts
 * The Varada cases need contracts/deployments/swap-fork.json (written by the fixture script).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, formatUnits, getAddress, http, keccak256, parseAbi, parseEther, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_ADDRESSES,
  ETH,
  ONDO_INFRA,
  ONDO_TOKENS,
  SwapError,
  USDC,
  WETH,
  buildSwapCalldata,
  buildTradeTransaction,
  clearDiscoveryCache,
  discoverPools,
  enumerateRoutes,
  erc20Abi,
  mapSwapError,
  pickBestQuote,
  planExecution,
  poolIdOf,
  quoteTrade,
  rankRoutes,
  readVaradaFee,
  routingNodes,
  permit2Abi,
  permitSingleTypedData,
  universalRouterAbi,
  varadaPoolKey,
  type SwapAsset,
  type TradeQuote,
  type VaradaMarketToken,
} from "../src/index.js";

const RPC = process.env.FORK_RPC_URL;
const fixturePath = resolve(__dirname, process.env.SWAP_FORK_FIXTURE_JSON ?? "../../../contracts/deployments/swap-fork.json");
const fixture = existsSync(fixturePath) ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, Address>) : null;

const fx = (fixture ?? {}) as Record<"factory" | "hook" | "liveHook" | "weeklyWeth" | "weeklyOndo" | "liveWeth", Address>;

const describeFork = RPC ? describe : describe.skip;
const describeVarada = RPC && fixture ? describe : describe.skip;

// A fresh key. The anvil dev accounts are EIP-7702 delegated on mainnet (they have code), which makes
// Permit2 verify signatures through ERC-1271 and makes ETH refunds revert; a real user is a plain account.
const trader = privateKeyToAccount(keccak256(toHex("varada swap fork test trader")));
const AMZN = ONDO_TOKENS.AMZNon.address;
const AMZN_ASSET: SwapAsset = { address: AMZN, symbol: "AMZNon", decimals: 18 };

const transport = http(RPC ?? "http://127.0.0.1:8546", { timeout: 180_000 });
const client = createPublicClient({ chain: mainnet, transport }) as PublicClient;
const wallet = createWalletClient({ account: trader, chain: mainnet, transport });
const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport });

// No snapshots: evm_snapshot clones the whole forked state and stalls anvil. Each test measures balance
// deltas, so they do not depend on each other; the time-travel test runs last.
beforeEach(() => {
  clearDiscoveryCache();
});

const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(`[fork] ${s}`);
};

/**
 * Executed output against the quote. Exact when nothing time-dependent is in the fee; while a launch surcharge
 * is decaying it falls with the block timestamp, so the next block may price 1 bp lower: then the execution
 * can only be better, by at most `toleranceBps`.
 */
function expectParity(executed: bigint, quoted: bigint, toleranceBps = 0n) {
  expect(executed).toBeGreaterThanOrEqual(quoted);
  expect(executed - quoted).toBeLessThanOrEqual((quoted * toleranceBps) / 10_000n);
}

/**
 * `eth_call` runs at the latest block's timestamp and anvil mines on demand, so after idle minutes a quote would see
 * an older launch surcharge than the next block does. Mining a block first gives the quote today's timestamp, like a
 * mainnet block 12 seconds ago.
 */
async function freshBlock() {
  await testClient.mine({ blocks: 1 });
  clearDiscoveryCache();
}

async function balanceOf(asset: Address, who: Address = trader.address): Promise<bigint> {
  return asset === ETH.address ? client.getBalance({ address: who }) : client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

async function send(tx: { to: Address; data: Hex; value?: bigint }) {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt;
}

/** approve (if needed) + signed permit + Universal Router call for a TradeQuote. Returns the receipt and the gas used by the swap. */
async function executeQuote(q: TradeQuote) {
  const plan = await planExecution(client, q, { account: trader.address, chainId: 1 });
  if (plan.resetTx) await send(plan.resetTx);
  if (plan.approveTx) {
    const r = await send(plan.approveTx);
    expect(r.status).toBe("success");
  }
  let signedPermit;
  if (plan.permit && plan.typedData) {
    const signature = await trader.signTypedData({ ...plan.typedData, message: plan.permit });
    signedPermit = { permit: plan.permit, signature };
  }
  const tx = buildTradeTransaction(q, { signedPermit, deadline: Number((await client.getBlock()).timestamp) + 1200 });
  return send(tx);
}

describeFork("hub pools on the fork (ETH, USDC, DAI, WBTC)", () => {
  beforeAll(async () => {
    expect(await client.getChainId()).toBe(1);
    await testClient.setBalance({ address: trader.address, value: parseEther("100000") });
  });

  it("finds the real ETH/USDC pools and the 0.05% pool id matches StateView", async () => {
    const pools = await discoverPools(client, routingNodes({}, [ETH.address, USDC.address]));
    const eth0 = pools.filter((p) => p.key.currency0 === ETH.address && p.key.currency1 === USDC.address);
    expect(eth0.map((p) => p.key.fee).sort((a, b) => a - b)).toEqual(expect.arrayContaining([500, 3000]));
    const p500 = eth0.find((p) => p.key.fee === 500)!;
    expect(p500.poolId).toBe("0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27");
    note(`ETH/USDC pools: ${eth0.map((p) => `${p.key.fee / 100}bp liq ${p.liquidity}`).join(", ")}`);
  });

  it("ETH -> USDC: quote equals the executed output; USDC -> ETH with a signed Permit2 permit", async () => {
    const pools = await discoverPools(client, routingNodes({}, [ETH.address, USDC.address]));
    const states = new Map(pools.map((p) => [p.poolId, p]));
    const ctx = { tokenIn: ETH, tokenOut: USDC, states };
    const amountIn = parseEther("1");
    const candidates = enumerateRoutes(pools, ETH.address, USDC.address, { weth: WETH.address });
    const routes = rankRoutes(candidates, states, amountIn, "exactIn", 4);
    const { best, all } = await pickBestQuote(client, routes, "exactIn", amountIn, ctx);
    note(`ETH->USDC best of ${all.length} quoted (${candidates.length} candidates): ${formatUnits(best.amountOut, 6)} USDC, impact ${best.priceImpactPct.toFixed(4)}%, mid ${best.midPrice.toFixed(2)}`);
    expect(best.midPrice).toBeGreaterThan(100);
    expect(best.priceImpactPct).toBeLessThan(0.5);

    const before = await balanceOf(USDC.address);
    const receipt = await send(buildSwapCalldata({ route: best.route, mode: "exactIn", amountIn, amountOut: (best.amountOut * 995n) / 1000n, deadline: Number((await client.getBlock()).timestamp) + 600 }));
    expect(receipt.status).toBe("success");
    const got = (await balanceOf(USDC.address)) - before;
    note(`executed: ${formatUnits(got, 6)} USDC (quoted ${formatUnits(best.amountOut, 6)}), gas ${receipt.gasUsed}`);
    expect(got).toBe(best.amountOut);

    // back: USDC -> ETH needs approve(permit2) + a signed permit consumed in the same call
    const sellIn = got / 2n;
    const back = await pickBestQuote(client, rankRoutes(enumerateRoutes(pools, USDC.address, ETH.address, { weth: WETH.address }), states, sellIn, "exactIn", 4), "exactIn", sellIn, { tokenIn: USDC, tokenOut: ETH, states });
    await send({ to: USDC.address, data: (await import("viem")).encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [EXTERNAL_ADDRESSES.permit2, 2n ** 256n - 1n] }) });
    const now = Number((await client.getBlock()).timestamp);
    const [, , nonce] = await client.readContract({ address: EXTERNAL_ADDRESSES.permit2, abi: permit2Abi, functionName: "allowance", args: [trader.address, USDC.address, EXTERNAL_ADDRESSES.universalRouter] });
    const permit = { details: { token: USDC.address, amount: sellIn, expiration: now + 1800, nonce: Number(nonce) }, spender: EXTERNAL_ADDRESSES.universalRouter, sigDeadline: BigInt(now + 1800) };
    const signature = await trader.signTypedData({ ...permitSingleTypedData(permit, EXTERNAL_ADDRESSES.permit2, 1), message: permit });
    const ethBefore = await balanceOf(ETH.address);
    const r2 = await wallet.sendTransaction({ ...buildSwapCalldata({ route: back.best.route, mode: "exactIn", amountIn: sellIn, amountOut: (back.best.amountOut * 99n) / 100n, deadline: now + 600, permit: { permit, signature } }), gas: 1_000_000n });
    const rc2 = await client.waitForTransactionReceipt({ hash: r2 });
    expect(rc2.status).toBe("success");
    const gasCost = rc2.gasUsed * rc2.effectiveGasPrice;
    const ethGot = (await balanceOf(ETH.address)) - ethBefore + gasCost;
    note(`USDC->ETH: ${formatUnits(ethGot, 18)} ETH (quoted ${formatUnits(back.best.amountOut, 18)})`);
    expect(ethGot).toBe(back.best.amountOut);
  });

  it("finds multi-hop routes and quotes exact-out", async () => {
    const dai = { address: getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F"), symbol: "DAI", decimals: 18 };
    const pools = await discoverPools(client, routingNodes({}, [ETH.address, dai.address]));
    const states = new Map(pools.map((p) => [p.poolId, p]));
    const routes = enumerateRoutes(pools, dai.address, ETH.address, { weth: WETH.address });
    expect(routes.length).toBeGreaterThan(1);
    const { best, all } = await pickBestQuote(client, rankRoutes(routes, states, parseEther("1000"), "exactIn", 4), "exactIn", parseEther("1000"), { tokenIn: dai, tokenOut: ETH, states });
    note(`DAI->ETH ${all.length} quoted of ${routes.length} candidates, best ${formatUnits(best.amountOut, 18)} ETH via ${best.route.steps.length} steps`);
    const out = await pickBestQuote(client, rankRoutes(routes, states, parseEther("0.1"), "exactOut", 3), "exactOut", parseEther("0.1"), { tokenIn: dai, tokenOut: ETH, states });
    expect(out.best.amountOut).toBe(parseEther("0.1"));
    expect(out.best.amountIn).toBeGreaterThan(0n);
  });

  it("maps real reverts: slippage and expired deadline", async () => {
    const pools = await discoverPools(client, routingNodes({}, [ETH.address, USDC.address]));
    const states = new Map(pools.map((p) => [p.poolId, p]));
    const { best } = await pickBestQuote(client, rankRoutes(enumerateRoutes(pools, ETH.address, USDC.address, { weth: WETH.address }), states, parseEther("1"), "exactIn", 2), "exactIn", parseEther("1"), { tokenIn: ETH, tokenOut: USDC, states });
    const now = Number((await client.getBlock()).timestamp);
    const tooTight = buildSwapCalldata({ route: best.route, mode: "exactIn", amountIn: parseEther("1"), amountOut: best.amountOut * 2n, deadline: now + 600 });
    const err1 = await client.call({ to: tooTight.to, data: tooTight.data, value: tooTight.value, account: trader.address }).then(() => null, (e) => e);
    expect(err1).not.toBeNull();
    expect(mapSwapError(err1).reason).toBe("slippage");
    const expired = buildSwapCalldata({ route: best.route, mode: "exactIn", amountIn: parseEther("1"), amountOut: 1n, deadline: now - 10 });
    const err2 = await client.call({ to: expired.to, data: expired.data, value: expired.value, account: trader.address }).then(() => null, (e) => e);
    expect(mapSwapError(err2).reason).toBe("deadline-expired");
  });
});

describeVarada("Varada tokens on the fork", () => {
  const weekly: VaradaMarketToken = { address: fx.weeklyWeth, symbol: "SWKL", hook: fx.hook, quote: WETH };
  const ondo: VaradaMarketToken = { address: fx.weeklyOndo, symbol: "SOND", hook: fx.hook, quote: AMZN_ASSET };
  const live: VaradaMarketToken = { address: fx.liveWeth, symbol: "SLIV", hook: fx.liveHook, quote: WETH };
  const ethAsset = ETH;

  beforeAll(async () => {
    await testClient.setBalance({ address: trader.address, value: parseEther("100000") });
  });

  it("reads the launch fee and pool state of each token", async () => {
    const w = await readVaradaFee(client, weekly.address, weekly.hook);
    expect(w).toMatchObject({ mode: "weekly", baseFeeBps: 300, sniperStartBps: 4000, sniperActive: true, causeShareBps: 9000, platformShareBps: 1000 });
    expect(w.feeBps).toBeGreaterThan(300);
    const o = await readVaradaFee(client, ondo.address, ondo.hook);
    expect(o).toMatchObject({ mode: "weekly", feeBps: 200, sniperActive: false, sniperEndsAt: null });
    const l = await readVaradaFee(client, live.address, live.hook);
    expect(l).toMatchObject({ mode: "live", baseFeeBps: 300, sniperStartBps: 2000 });
    note(`fees now: weekly ${w.feeBps}bp (sniper ${w.sniperBps}), ondo ${o.feeBps}bp, live ${l.feeBps}bp (sniper ${l.sniperBps})`);
    const factoryTick = await client.readContract({ address: fx.factory, abi: parseAbi(["function TICK_SPACING() view returns (int24)"]), functionName: "TICK_SPACING" });
    expect(factoryTick).toBe(200);
  });

  it("buys the WETH-quoted weekly token with ETH, then sells it back to ETH (quote == execution)", async () => {
    const amount = parseEther("1");
    await freshBlock();
    const q = await quoteTrade(client, { token: weekly, side: "buy", asset: ethAsset, amount, slippageBps: 100 });
    note(`buy 1 ETH -> ${formatUnits(q.amountOut, 18)} SWKL, route ${q.routeLabel}, fee ${q.fee.feeBps}bp (sniper ${q.fee.sniperBps}), impact ${q.best.priceImpactPct.toFixed(3)}%, mid ${q.best.midPrice}`);
    expect(q.routeLabel).toBe("ETH > WETH > SWKL");
    expect(q.fee.sniperActive).toBe(true);
    expect(q.blockers).toEqual([]);
    const tokenBefore = await balanceOf(weekly.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    const received = (await balanceOf(weekly.address)) - tokenBefore;
    note(`executed buy: ${formatUnits(received, 18)} SWKL (quoted ${formatUnits(q.amountOut, 18)}), gas ${receipt.gasUsed}`);
    expectParity(received, q.amountOut, 10n);
    expect(received).toBeGreaterThanOrEqual(q.amountOutMin);

    // sell half back to ETH: needs approve + permit on the Varada token
    const sellAmount = received / 2n;
    await freshBlock();
    const s = await quoteTrade(client, { token: weekly, side: "sell", asset: ethAsset, amount: sellAmount, slippageBps: 100 });
    note(`sell quote: ${formatUnits(sellAmount, 18)} SWKL -> ${formatUnits(s.amountOut, 18)} ETH, fee ${s.fee.feeBps}bp, impact ${s.best.priceImpactPct.toFixed(3)}%`);
    expect(s.routeLabel).toBe("SWKL > WETH > ETH");
    const ethBefore = await balanceOf(ETH.address);
    const r2 = await executeQuote(s);
    expect(r2.status).toBe("success");
    const ethGot = (await balanceOf(ETH.address)) - ethBefore + r2.gasUsed * r2.effectiveGasPrice;
    note(`executed sell: ${formatUnits(sellAmount, 18)} SWKL -> ${formatUnits(ethGot, 18)} ETH (quoted ${formatUnits(s.amountOut, 18)}), gas ${r2.gasUsed}`);
    // the surcharge may have decayed a bp or two since the quote: the execution can only be better
    expect(ethGot).toBeGreaterThanOrEqual(s.amountOut - 100_000n * 1_000_000_000n); // minus the approve transaction's gas
    expect(ethGot).toBeLessThanOrEqual((s.amountOut * 10_010n) / 10_000n);
  });

  it("pays with USDC: ETH -> USDC first, then USDC buys the token through a multi-hop route", async () => {
    // get USDC with ETH through the engine's own hub routing
    const hubPools = await discoverPools(client, routingNodes({}, [ETH.address, USDC.address]));
    const states = new Map(hubPools.map((p) => [p.poolId, p]));
    const eu = await pickBestQuote(client, rankRoutes(enumerateRoutes(hubPools, ETH.address, USDC.address, { weth: WETH.address }), states, parseEther("2"), "exactIn", 3), "exactIn", parseEther("2"), { tokenIn: ETH, tokenOut: USDC, states });
    await send(buildSwapCalldata({ route: eu.best.route, mode: "exactIn", amountIn: parseEther("2"), amountOut: eu.best.amountOut - eu.best.amountOut / 100n, deadline: Number((await client.getBlock()).timestamp) + 600 }));
    const usdc = await balanceOf(USDC.address);
    expect(usdc).toBeGreaterThan(1000n * 10n ** 6n);

    await freshBlock();
    const q = await quoteTrade(client, { token: weekly, side: "buy", asset: USDC, amount: 1000n * 10n ** 6n, slippageBps: 100 });
    note(`buy with 1000 USDC -> ${formatUnits(q.amountOut, 18)} SWKL via ${q.routeLabel} (${q.alternatives.length} routes quoted)`);
    expect(q.best.route.steps.filter((s) => s.kind === "pool").length).toBeGreaterThanOrEqual(2);
    const tokenBefore = await balanceOf(weekly.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    const received = (await balanceOf(weekly.address)) - tokenBefore;
    note(`executed: ${formatUnits(received, 18)} SWKL (quoted ${formatUnits(q.amountOut, 18)}), gas ${receipt.gasUsed}`);
    expectParity(received, q.amountOut, 10n);
  });

  it("exact-out: buys exactly 100 SWKL with WETH", async () => {
    await send({ to: WETH.address, data: (await import("viem")).encodeFunctionData({ abi: [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }], functionName: "deposit" }), value: parseEther("2") });
    await freshBlock();
    const q = await quoteTrade(client, { token: weekly, side: "buy", asset: WETH, amount: 100n * 10n ** 18n, mode: "exactOut", slippageBps: 100 });
    note(`exact-out 100 SWKL costs ${formatUnits(q.amountIn, 18)} WETH (max ${formatUnits(q.amountInMax, 18)})`);
    const before = await balanceOf(weekly.address);
    const wethBefore = await balanceOf(WETH.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    expect((await balanceOf(weekly.address)) - before).toBe(100n * 10n ** 18n);
    const spent = wethBefore - (await balanceOf(WETH.address));
    note(`exact-out executed: spent ${formatUnits(spent, 18)} WETH`);
    // exact output: the price of the exact amount can only fall as the surcharge decays
    expect(spent).toBeLessThanOrEqual(q.amountIn);
    expect(spent).toBeGreaterThan((q.amountIn * 9_990n) / 10_000n);
  });

  it("exact-out paying in ETH: wrap, swap, refund the unused ETH", async () => {
    await freshBlock();
    const q = await quoteTrade(client, { token: weekly, side: "buy", asset: ethAsset, amount: 100n * 10n ** 18n, mode: "exactOut", slippageBps: 200 });
    const before = await balanceOf(weekly.address);
    const ethBefore = await balanceOf(ETH.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    expect((await balanceOf(weekly.address)) - before).toBe(100n * 10n ** 18n);
    const spent = ethBefore - (await balanceOf(ETH.address)) - receipt.gasUsed * receipt.effectiveGasPrice;
    note(`exact-out in ETH: spent ${formatUnits(spent, 18)} ETH (quote ${formatUnits(q.amountIn, 18)}, max ${formatUnits(q.amountInMax, 18)})`);
    expect(spent).toBeLessThanOrEqual(q.amountIn);
    expect(spent).toBeGreaterThan((q.amountIn * 9_990n) / 10_000n);
  });

  // The real AMZNon pools are thin (the USDC pool holds about $10k): a size the engine can route at a sane price.
  const ONDO_SIZE = parseEther("0.003");

  it("blocks a size whose price impact is absurd instead of offering it", async () => {
    const q = await quoteTrade(client, { token: ondo, side: "buy", asset: ethAsset, amount: parseEther("1"), slippageBps: 200 });
    note(`ondo 1 ETH: ${formatUnits(q.amountOut, 18)} SOND, impact ${q.best.priceImpactPct.toFixed(2)}%, blockers ${q.blockers}`);
    expect(q.best.priceImpactPct).toBeGreaterThan(30);
    expect(q.blockers).toEqual(["price-impact"]);
    expect(() => buildTradeTransaction(q)).toThrow(expect.objectContaining({ reason: "price-impact" }));
  });

  it("buys an AMZNon-quoted token with ETH through the thin AMZNon pools, then sells to USDC", async () => {
    const q = await quoteTrade(client, { token: ondo, side: "buy", asset: ethAsset, amount: ONDO_SIZE, slippageBps: 300 }, { compliance: { account: trader.address, accountClient: client, marketOpen: false } });
    note(`ondo buy ${formatUnits(ONDO_SIZE, 18)} ETH -> ${formatUnits(q.amountOut, 18)} SOND, route ${q.routeLabel} (${q.alternatives.length} quoted), impact ${q.best.priceImpactPct.toFixed(3)}%, warnings ${q.compliance.warnings.map((w) => w.reason)}`);
    expect(q.best.route.steps.filter((s) => s.kind === "pool").length).toBeGreaterThanOrEqual(2);
    expect(q.routeLabel).toContain("AMZNon");
    expect(q.blockers).toEqual([]);
    expect(q.compliance.warnings.map((w) => w.reason)).toEqual(["market-closed"]);
    const before = await balanceOf(ondo.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    const received = (await balanceOf(ondo.address)) - before;
    note(`ondo executed: ${formatUnits(received, 18)} SOND (quoted ${formatUnits(q.amountOut, 18)}), gas ${receipt.gasUsed}`);
    expect(received).toBe(q.amountOut); // no surcharge on this token: exact

    const s = await quoteTrade(client, { token: ondo, side: "sell", asset: USDC, amount: received / 2n, slippageBps: 200 });
    note(`ondo sell route ${s.routeLabel}: ${formatUnits(s.amountOut, 6)} USDC`);
    const usdcBefore = await balanceOf(USDC.address);
    const r2 = await executeQuote(s);
    expect(r2.status).toBe("success");
    expect((await balanceOf(USDC.address)) - usdcBefore).toBe(s.amountOut);
  });

  it("blocks a trade when the Ondo quote asset is paused; the pause only matters where the token moves", async () => {
    // get a little AMZNon first (the pools are thin, so a small size), while it still trades
    const nodes = routingNodes({}, [ETH.address, AMZN]);
    const pools = await discoverPools(client, nodes);
    const st = new Map(pools.map((p) => [p.poolId, p]));
    const toAmzn = await pickBestQuote(client, rankRoutes(enumerateRoutes(pools, ETH.address, AMZN, { weth: WETH.address }), st, parseEther("0.003"), "exactIn", 4), "exactIn", parseEther("0.003"), { tokenIn: ETH, tokenOut: AMZN_ASSET, states: st });
    await send(buildSwapCalldata({ route: toAmzn.best.route, mode: "exactIn", amountIn: parseEther("0.003"), amountOut: toAmzn.best.amountOut - toAmzn.best.amountOut / 20n, deadline: Number((await client.getBlock()).timestamp) + 600 }));
    const amznBalance = await balanceOf(AMZN);
    expect(amznBalance).toBeGreaterThan(0n);

    const mgr = ONDO_INFRA.tokenPauseManager;
    const abi = parseAbi(["function PAUSE_TOKEN_ROLE() view returns (bytes32)", "function UNPAUSE_TOKEN_ROLE() view returns (bytes32)", "function getRoleMember(bytes32,uint256) view returns (address)", "function pauseToken(address)", "function unpauseToken(address)", "function isTokenPaused(address) view returns (bool)"]);
    const pauser = await client.readContract({ address: mgr, abi, functionName: "getRoleMember", args: [await client.readContract({ address: mgr, abi, functionName: "PAUSE_TOKEN_ROLE" }), 0n] });
    const unpauser = await client.readContract({ address: mgr, abi, functionName: "getRoleMember", args: [await client.readContract({ address: mgr, abi, functionName: "UNPAUSE_TOKEN_ROLE" }), 0n] });
    for (const a of [pauser, unpauser]) {
      await testClient.impersonateAccount({ address: a });
      await testClient.setBalance({ address: a, value: parseEther("1") });
    }
    const imp = createWalletClient({ account: pauser, chain: mainnet, transport });
    const impUnpause = createWalletClient({ account: unpauser, chain: mainnet, transport });
    await client.waitForTransactionReceipt({ hash: await imp.writeContract({ address: mgr, abi, functionName: "pauseToken", args: [AMZN] }) });
    expect(await client.readContract({ address: mgr, abi, functionName: "isTokenPaused", args: [AMZN] })).toBe(true);
    clearDiscoveryCache();

    const q = await quoteTrade(client, { token: ondo, side: "buy", asset: ethAsset, amount: ONDO_SIZE, slippageBps: 300 });
    expect(q.blockers).toEqual(["paused"]);
    expect(q.compliance.blockers[0]).toMatchObject({ reason: "paused", symbol: "AMZNon" });
    expect(() => buildTradeTransaction(q)).toThrow(SwapError);

    // on chain: the paused token refuses to move ...
    await expect(wallet.writeContract({ address: AMZN, abi: erc20Abi, functionName: "transfer", args: [pauser, 1n] })).rejects.toBeDefined();
    // ... while an ETH-paid swap that only routes through it nets its flow to zero inside the pool manager and succeeds
    const forced = buildSwapCalldata({ route: q.best.route, mode: "exactIn", amountIn: q.amountIn, amountOut: 1n, deadline: Number((await client.getBlock()).timestamp) + 600 });
    await expect(client.call({ to: forced.to, data: forced.data, value: forced.value, account: trader.address })).resolves.toBeDefined();
    note("paused AMZNon: quote blocked with [paused] (it is the pool's quote asset); AMZNon.transfer reverts; the ETH-paid swap through it still simulates fine (zero net movement)");

    // paying WITH the paused token cannot work: Permit2 cannot pull it
    const withAmzn = await quoteTrade(client, { token: ondo, side: "buy", asset: AMZN_ASSET, amount: amznBalance / 2n, slippageBps: 300 });
    expect(withAmzn.blockers).toEqual(["paused"]);

    await client.waitForTransactionReceipt({ hash: await impUnpause.writeContract({ address: mgr, abi, functionName: "unpauseToken", args: [AMZN] }) });
    expect(await client.readContract({ address: mgr, abi, functionName: "isTokenPaused", args: [AMZN] })).toBe(false);
    clearDiscoveryCache();
    expect((await quoteTrade(client, { token: ondo, side: "buy", asset: ethAsset, amount: ONDO_SIZE, slippageBps: 300 })).blockers).toEqual([]);
  });

  it("trades the live-hook token: quote equals execution and the gas the hook needs is found by estimation", async () => {
    await freshBlock();
    const q = await quoteTrade(client, { token: live, side: "buy", asset: ethAsset, amount: parseEther("1"), slippageBps: 100 });
    note(`live buy 1 ETH -> ${formatUnits(q.amountOut, 18)} SLIV, fee ${q.fee.feeBps}bp mode ${q.fee.mode}`);
    expect(q.fee.mode).toBe("live");
    const before = await balanceOf(live.address);
    const receipt = await executeQuote(q);
    expect(receipt.status).toBe("success");
    const received = (await balanceOf(live.address)) - before;
    note(`live executed: ${formatUnits(received, 18)} SLIV (quoted ${formatUnits(q.amountOut, 18)}), gas ${receipt.gasUsed}`);
    expectParity(received, q.amountOut, 10n);
    await freshBlock();
    const s = await quoteTrade(client, { token: live, side: "sell", asset: ethAsset, amount: received / 3n, slippageBps: 100 });
    const ethBefore = await balanceOf(ETH.address);
    const r2 = await executeQuote(s);
    expect(r2.status).toBe("success");
    note(`live sell: quoted ${formatUnits(s.amountOut, 18)} ETH, gas ${r2.gasUsed}`);
    expect((await balanceOf(ETH.address)) - ethBefore + r2.gasUsed * r2.effectiveGasPrice).toBeGreaterThan((s.amountOut * 98n) / 100n);
  });

  it("the sniper surcharge decays: the fee and the price move with time", async () => {
    const q0 = await quoteTrade(client, { token: weekly, side: "buy", asset: WETH, amount: parseEther("0.1"), slippageBps: 100 });
    await testClient.increaseTime({ seconds: 2 * 24 * 3600 });
    await testClient.mine({ blocks: 1 });
    clearDiscoveryCache();
    const q1 = await quoteTrade(client, { token: weekly, side: "buy", asset: WETH, amount: parseEther("0.1"), slippageBps: 100 });
    note(`sniper decay: fee ${q0.fee.feeBps}bp -> ${q1.fee.feeBps}bp, tokens per 0.1 WETH ${formatUnits(q0.amountOut, 18)} -> ${formatUnits(q1.amountOut, 18)}`);
    expect(q0.fee.sniperActive).toBe(true);
    expect(q1.fee.sniperActive).toBe(false);
    expect(q1.fee.feeBps).toBe(300);
    expect(q1.amountOut).toBeGreaterThan(q0.amountOut);
  });
});

describeFork("summary", () => {
  it("prints the evidence", () => {
    console.log(["", "FORK RESULTS", ...log].join("\n"));
  });
});

void universalRouterAbi;
void poolIdOf;
void varadaPoolKey;
