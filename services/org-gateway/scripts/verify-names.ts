/**
 * Resolves org names on Ethereum mainnet the way a wallet does (viem getEnsAddress through the ENS
 * Universal Resolver, with CCIP-Read), for Ethereum, Optimism and Base, plus the `url` text record.
 *   tsx scripts/verify-names.ts [label ...]     (default: givedirectly-inc, NPR, an unknown label)
 */
import { createPublicClient, http } from "viem";
import { mainnet, optimism, base } from "viem/chains";
import { toCoinType } from "viem";
const c = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com", { timeout: 60_000 }) });
const labels = process.argv.slice(2).length ? process.argv.slice(2) : ["givedirectly-inc", "national-public-radio-inc", "definitely-not-a-charity-xyz"];
for (const label of labels) {
  const name = label + ".org.varada.eth";
  for (const [chainName, coinType] of [["ethereum", 60n], ["optimism", toCoinType(optimism.id)], ["base", toCoinType(base.id)]] as const) {
    const t = Date.now();
    try {
      const a = await c.getEnsAddress({ name, coinType });
      console.log(name.padEnd(50), chainName.padEnd(9), a ?? "(none)", (Date.now() - t) + "ms");
    } catch (e) { console.log(name, chainName, "ERROR", (e as Error).message.split("\n")[0]); }
  }
}
const ch = await c.getEnsText({ name: "givedirectly-inc.org.varada.eth", key: "url" });
console.log("url text:", ch);
