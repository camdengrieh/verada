import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";
import {
  AgentVaultAbi,
  CauseCatalogAbi,
  CuratorRegistryAbi,
  CauseRegistryAbi,
  DonationDistributorAbi,
  EndaomentEntityAbi,
  EpochGovernorAbi,
  FeeConsolidatorAbi,
  FeeVaultAbi,
  LiveDonationVaultAbi,
  QuoteRegistryAbi,
  RotationGovernorAbi,
  TakeoverGovernorAbi,
  TokenProfileRegistryAbi,
  VaradaFactoryAbi,
  VaradaLiveHookAbi,
  ZamaVotingSchemeAbi,
  VaradaTokenAbi,
} from "./src/abis";
import { POOL_MANAGER } from "./src/pool-manager";
import { MAINNET_CHAIN_ID, readEnv } from "./src/env";

const env = readEnv(process.env);

export default createConfig({
  chains: {
    mainnet: { id: MAINNET_CHAIN_ID, rpc: env.rpcUrls.length === 1 ? env.rpcUrls[0] : env.rpcUrls },
  },
  contracts: {
    Factory: {
      abi: VaradaFactoryAbi,
      chain: "mainnet",
      address: env.factory,
      startBlock: env.startBlock,
    },
    // Every Varada token (child of the factory's `TokenCreated`): all transfers, for holder balances.
    VaradaToken: {
      abi: VaradaTokenAbi,
      chain: "mainnet",
      address: factory({
        address: env.factory,
        event: getAbiItem({ abi: VaradaFactoryAbi, name: "TokenCreated" }),
        parameter: "token",
      }),
      startBlock: env.startBlock,
    },
    // The same tokens, only transfers into or out of the PoolManager. The handler reads those
    // transactions' receipts; their PoolManager `Swap` logs are the trades.
    VaradaTokenPool: {
      abi: VaradaTokenAbi,
      chain: "mainnet",
      address: factory({
        address: env.factory,
        event: getAbiItem({ abi: VaradaFactoryAbi, name: "TokenCreated" }),
        parameter: "token",
      }),
      filter: [
        { event: "Transfer", args: { from: POOL_MANAGER } },
        { event: "Transfer", args: { to: POOL_MANAGER } },
      ],
      startBlock: env.startBlock,
    },
    FeeVault: {
      abi: FeeVaultAbi,
      chain: "mainnet",
      address: env.feeVault,
      startBlock: env.startBlock,
    },
    FeeConsolidator: {
      abi: FeeConsolidatorAbi,
      chain: "mainnet",
      address: env.feeConsolidator,
      startBlock: env.startBlock,
    },
    QuoteRegistry: {
      abi: QuoteRegistryAbi,
      chain: "mainnet",
      address: env.quoteRegistry,
      startBlock: env.startBlock,
    },
    CauseRegistry: {
      abi: CauseRegistryAbi,
      chain: "mainnet",
      address: env.causeRegistry,
      startBlock: env.startBlock,
    },
    CuratorRegistry: {
      abi: CuratorRegistryAbi,
      chain: "mainnet",
      address: env.curatorRegistry,
      startBlock: env.startBlock,
    },
    // One vault per curator agent, created by `registerAgent`.
    AgentVault: {
      abi: AgentVaultAbi,
      chain: "mainnet",
      address: factory({
        address: env.curatorRegistry,
        event: getAbiItem({ abi: CuratorRegistryAbi, name: "AgentRegistered" }),
        parameter: "vault",
      }),
      startBlock: env.startBlock,
    },
    CauseCatalog: {
      abi: CauseCatalogAbi,
      chain: "mainnet",
      address: env.causeCatalog,
      startBlock: env.startBlock,
    },
    EpochGovernor: {
      abi: EpochGovernorAbi,
      chain: "mainnet",
      address: env.epochGovernor,
      startBlock: env.startBlock,
    },
    DonationDistributor: {
      abi: DonationDistributorAbi,
      chain: "mainnet",
      address: env.donationDistributor,
      startBlock: env.startBlock,
    },
    TokenProfileRegistry: {
      abi: TokenProfileRegistryAbi,
      chain: "mainnet",
      address: env.tokenRegistry,
      startBlock: env.startBlock,
    },
    // Ballots for both governors go through the scheme; a replacement scheme needs its own entry.
    ZamaVotingScheme: {
      abi: ZamaVotingSchemeAbi,
      chain: "mainnet",
      address: env.votingScheme,
      startBlock: env.startBlock,
    },
    TakeoverGovernor: {
      abi: TakeoverGovernorAbi,
      chain: "mainnet",
      address: env.takeoverGovernor,
      startBlock: env.startBlock,
    },
    // Live-donation mode: the hook and vault are found through the factory's one-time
    // `LiveModeConfigured`, so nothing is indexed for them until live mode is enabled.
    VaradaLiveHook: {
      abi: VaradaLiveHookAbi,
      chain: "mainnet",
      address: factory({
        address: env.factory,
        event: getAbiItem({ abi: VaradaFactoryAbi, name: "LiveModeConfigured" }),
        parameter: "liveHook",
      }),
      startBlock: env.startBlock,
    },
    LiveDonationVault: {
      abi: LiveDonationVaultAbi,
      chain: "mainnet",
      address: factory({
        address: env.factory,
        event: getAbiItem({ abi: VaradaFactoryAbi, name: "LiveModeConfigured" }),
        parameter: "liveVault",
      }),
      startBlock: env.startBlock,
    },
    // Direct donations to Endaoment orgs from any address, for the per-cause donor leaderboards.
    // No address filter: the handler keeps only logs whose emitter is a real Endaoment org (its
    // `orgId()` maps back to it through the OrgFundFactory), so a look-alike event is ignored.
    EndaomentOrg: {
      abi: EndaomentEntityAbi,
      chain: "mainnet",
      startBlock: env.endaomentStartBlock,
    },
    // Optional (ROTATION_GOVERNOR_ADDRESS); the zero address indexes nothing.
    RotationGovernor: {
      abi: RotationGovernorAbi,
      chain: "mainnet",
      address: env.rotationGovernor,
      startBlock: env.startBlock,
    },
  },
});
