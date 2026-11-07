import { createPublicClient, http } from "viem";
import { mainnet, optimism, base } from "viem/chains";
import { toCoinType } from "viem";
const c = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com", { timeout: 60_000 }) });
for (const label of ["givedirectly-inc", "national-public-radio-inc", "definitely-not-a-charity-xyz"]) {
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
