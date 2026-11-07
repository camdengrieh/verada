/**
 * Giving USDC straight to one Endaoment charity, on Ethereum mainnet. The charity's deposit address
 * is the Endaoment OrgFundFactory's CREATE2 address for its org id, read on chain (never taken from
 * the indexer). A deployed org takes `USDC.approve(org, amount)` then `org.donate(amount)`, and only
 * while Endaoment's registry lists it as active; an org with no code yet takes
 * `USDC.approve(factory, amount)` then `factory.deployOrgAndDonate(orgId, amount)`, which deploys it
 * at that same address and credits it. Endaoment takes its platform fee out of the gift.
 *
 * Its ENS name, `<label>.org.<parent>`, is resolved by Varada's org resolver to that same factory
 * address, so the name and the address shown side by side are the same destination.
 */
import { erc20Abi, getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ENDAOMENT_REGISTRY, ORG_FUND_FACTORY } from "@varada/endaoment-client";

export { ENDAOMENT_REGISTRY, ORG_FUND_FACTORY };

export const orgFactoryAbi = parseAbi([
  "function computeOrgAddress(bytes32 orgId) view returns (address)",
  "function deployOrgAndDonate(bytes32 orgId, uint256 amount) returns (address)",
]);
export const endaomentOrgAbi = parseAbi(["function donate(uint256 amount)", "function orgId() view returns (bytes32)"]);
export const endaomentRegistryAbi = parseAbi(["function isActiveEntity(address entity) view returns (bool)"]);

/** `<label>.org.<parent>`, e.g. `givedirectly.org.varada.eth`; null without a label. */
export function orgEnsName(label: string | null | undefined, parent: string): string | null {
  return label ? `${label}.org.${parent}` : null;
}

/** The org id to give under on Ethereum: the catalogue's per-chain id when it has one. */
export function ethOrgIdOf(org: { orgId: string; ethOrgId?: string | null }): Hex {
  return (org.ethOrgId ?? org.orgId).toLowerCase() as Hex;
}

/** What the chain says about a charity's deposit address. */
export interface OrgTarget {
  orgId: Hex;
  address: Address;
  deployed: boolean;
  /** Endaoment's registry lists the deployed org as active (null when not deployed). */
  active: boolean | null;
  /** The deployed entity's own org id matches the one we give under (null when not deployed). */
  idMatches: boolean | null;
}

export type OrgRoute = { kind: "donate"; spender: Address } | { kind: "deploy"; spender: Address } | { kind: "blocked"; reason: string };

/** Reads the deposit address and its state from the factory, the code and the registry. */
export async function readOrgTarget(chain: Pick<PublicClient, "readContract" | "getCode">, orgId: Hex): Promise<OrgTarget> {
  const address = getAddress(await chain.readContract({ address: ORG_FUND_FACTORY, abi: orgFactoryAbi, functionName: "computeOrgAddress", args: [orgId] }));
  const code = await chain.getCode({ address });
  const deployed = Boolean(code && code !== "0x");
  if (!deployed) return { orgId, address, deployed, active: null, idMatches: null };
  const [active, entityId] = await Promise.all([
    chain.readContract({ address: ENDAOMENT_REGISTRY, abi: endaomentRegistryAbi, functionName: "isActiveEntity", args: [address] }),
    chain.readContract({ address, abi: endaomentOrgAbi, functionName: "orgId" }),
  ]);
  return { orgId, address, deployed, active, idMatches: entityId.toLowerCase() === orgId.toLowerCase() };
}

/** Which call pays the charity, and who the USDC allowance is for; or why it cannot be paid. */
export function orgRoute(t: OrgTarget): OrgRoute {
  if (!t.deployed) return { kind: "deploy", spender: ORG_FUND_FACTORY };
  if (t.idMatches === false) return { kind: "blocked", reason: "The contract at this charity's address reports a different org id, so gifts to it are blocked." };
  if (t.active === false) return { kind: "blocked", reason: "Endaoment does not list this charity as active right now, so it cannot take gifts." };
  return { kind: "donate", spender: t.address };
}

/** `USDC.approve(spender, amount)`. */
export function approveSpenderRequest(p: { usdc: Address; spender: Address; amount: bigint; chainId: number }) {
  return { address: p.usdc, abi: erc20Abi, functionName: "approve", args: [p.spender, p.amount], chainId: p.chainId } as const;
}

/** The paying call: `org.donate(amount)` for a deployed org, `factory.deployOrgAndDonate(orgId, amount)` otherwise. */
export function orgGiftRequest(p: { target: OrgTarget; amount: bigint; chainId: number }) {
  return p.target.deployed
    ? ({ address: p.target.address, abi: endaomentOrgAbi, functionName: "donate", args: [p.amount], chainId: p.chainId } as const)
    : ({ address: ORG_FUND_FACTORY, abi: orgFactoryAbi, functionName: "deployOrgAndDonate", args: [p.target.orgId, p.amount], chainId: p.chainId } as const);
}

/** `etherscan.io/address/<address>` on mainnet; undefined elsewhere. */
export function addressUrl(chainId: number, address: string): string | undefined {
  return chainId === 1 && /^0x[0-9a-fA-F]{40}$/.test(address) ? `https://etherscan.io/address/${address}` : undefined;
}
