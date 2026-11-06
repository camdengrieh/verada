// ABIs come from the SDK, which generates them from the forge artifacts.
export {
  varadaFactoryAbi as VaradaFactoryAbi,
  feeVaultAbi as FeeVaultAbi,
  feeConsolidatorAbi as FeeConsolidatorAbi,
  quoteRegistryAbi as QuoteRegistryAbi,
  causeRegistryAbi as CauseRegistryAbi,
  causeCatalogAbi as CauseCatalogAbi,
  curatorRegistryAbi as CuratorRegistryAbi,
  agentVaultAbi as AgentVaultAbi,
  epochGovernorAbi as EpochGovernorAbi,
  donationDistributorAbi as DonationDistributorAbi,
  tokenProfileRegistryAbi as TokenProfileRegistryAbi,
  zamaVotingSchemeAbi as ZamaVotingSchemeAbi,
  takeoverGovernorAbi as TakeoverGovernorAbi,
  varadaLiveHookAbi as VaradaLiveHookAbi,
  liveDonationVaultAbi as LiveDonationVaultAbi,
  rotationGovernorAbi as RotationGovernorAbi,
  varadaTokenAbi as VaradaTokenAbi,
} from "@varada/sdk/abis";

/**
 * Endaoment entities (orgs and funds share `Entity`). Every direct donation to an org emits
 * `EntityDonationReceived` from the org's own address; `amountReceived` is the gross USDC amount
 * (before Endaoment's fee, after the swap for `swapAndDonate`).
 */
export const EndaomentEntityAbi = [
  {
    type: "event",
    name: "EntityDonationReceived",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountReceived", type: "uint256", indexed: false },
      { name: "amountFee", type: "uint256", indexed: false },
    ],
  },
  { type: "function", name: "orgId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
] as const;

/** Endaoment OrgFundFactory (the same address on chains 1, 10 and 8453). */
export const EndaomentFactoryAbi = [
  {
    type: "function",
    name: "computeOrgAddress",
    stateMutability: "view",
    inputs: [{ name: "_orgId", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
