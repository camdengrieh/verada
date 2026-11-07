/**
 * Mainnet check that discovery finds the hookless Ondo v4 pools on the odd tiers the default list
 * missed. Skipped unless FORK_RPC_URL is set (an anvil fork or any mainnet RPC; only reads):
 *   FORK_RPC_URL=http://127.0.0.1:28545 pnpm --filter @varada/sdk exec vitest run test/swap/ondo-tiers.fork.test.ts
 * The pools are identified by tier and token pair, not by liquidity, so the test survives the pools
 * being drained: it asserts the pool is initialized and that the old tier list could not see it.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_TIERS,
  DEFAULT_HUBS,
  EXTERNAL_ADDRESSES,
  NATIVE_CURRENCY,
  ONDO_FEE_TIERS,
  ONDO_TOKENS,
  buildPoolKey,
  candidatePoolKeys,
  discoverPools,
  poolIdOf,
  readPoolStates,
  routingNodes,
} from "../../src/index.js";

const RPC = process.env.FORK_RPC_URL;
const d = RPC ? describe : describe.skip;
const client = (RPC ? createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) }) : undefined) as PublicClient;

const usdc = EXTERNAL_ADDRESSES.usdc;
const cases = [
  { name: "AAPLon/USDC 5% ts500", a: ONDO_TOKENS.AAPLon.address, b: usdc, fee: 50_000, ts: 500 },
  { name: "FXIon/USDC 4.99% ts499", a: ONDO_TOKENS.FXIon.address, b: usdc, fee: 49_900, ts: 499 },
  { name: "SGOVon/USDC 3.8% ts380", a: ONDO_TOKENS.SGOVon.address, b: usdc, fee: 38_000, ts: 380 },
  { name: "QQQon/USDC 0.65% ts65", a: ONDO_TOKENS.QQQon.address, b: usdc, fee: 6_500, ts: 65 },
  { name: "NVDAon/USDC 0.51% ts51", a: ONDO_TOKENS.NVDAon.address, b: usdc, fee: 5_100, ts: 51 },
  { name: "NVDAon/USDC 0.9% ts90", a: ONDO_TOKENS.NVDAon.address, b: usdc, fee: 9_000, ts: 90 },
  { name: "EEMon/ETH 0.25% ts25", a: ONDO_TOKENS.EEMon.address, b: NATIVE_CURRENCY, fee: 2_500, ts: 25 },
  { name: "AMZNon/USDC 2% ts200", a: ONDO_TOKENS.AMZNon.address, b: usdc, fee: 20_000, ts: 200 },
];

d("odd Ondo v4 tiers on mainnet", () => {
  it.each(cases)(
    "$name is initialized and covered only by the Ondo tiers",
    async (c) => {
      const key = buildPoolKey({ currencyA: c.a, currencyB: c.b, fee: c.fee, tickSpacing: c.ts });
      const [state] = await readPoolStates(client, [key]);
      expect(state!.initialized).toBe(true);
      const id = poolIdOf(key);
      const hubs = DEFAULT_HUBS.map((h) => h.address);
      expect(candidatePoolKeys([c.a, ...hubs], DEFAULT_FEE_TIERS, hubs).map(poolIdOf)).toContain(id);
      expect(candidatePoolKeys([c.a, ...hubs], DEFAULT_FEE_TIERS, hubs, []).map(poolIdOf)).not.toContain(id);
    },
    60_000,
  );

  it("discoverPools finds those pools with liquidity, in one batched read", async () => {
    const nodes = routingNodes({}, cases.map((c) => c.a));
    const keys = candidatePoolKeys(nodes, DEFAULT_FEE_TIERS, DEFAULT_HUBS.map((h) => h.address));
    const t0 = Date.now();
    const found = await discoverPools(client, nodes, {}, [], { bypassCache: true });
    const ms = Date.now() - t0;
    console.log(`[fork] ${nodes.length} nodes, ${keys.length} candidate keys (${ONDO_FEE_TIERS.length} extra Ondo tiers), ${found.length} live pools, ${ms} ms`);
    const without = await discoverPools(client, nodes, { ondoFeeTiers: [] }, [], { bypassCache: true });
    expect(found.length).toBeGreaterThan(without.length);
    const ids = new Set(found.map((s) => s.poolId));
    const hit = cases.filter((c) => ids.has(poolIdOf(buildPoolKey({ currencyA: c.a, currencyB: c.b, fee: c.fee, tickSpacing: c.ts }))));
    expect(hit.length).toBeGreaterThanOrEqual(cases.length - 1); // one may have been fully withdrawn since the survey
  }, 120_000);
});
