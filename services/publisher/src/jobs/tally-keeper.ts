import { createDonationReader, type DonationReader } from "@verada/sdk";
import type { Hex } from "viem";
import type { KeeperConfig } from "../env.js";
import type { IndexerClient } from "../indexer-client.js";
import { createBallotPreparer, createRoundPreparer, type BallotReader, type RoundReader } from "../keeper/ballot.js";
import type { ChainReader, ChainWriter, FactoryLogReader, RotationReader } from "../keeper/chain.js";
import { createZamaDecryptor, type PublicDecryptor } from "../keeper/decrypt.js";
import { createDonationPlanner } from "../keeper/donate.js";
import { createKeeper, type KeeperDeps } from "../keeper/keeper.js";
import { createTokenSource } from "../keeper/tokens.js";
import { createViemChain } from "../keeper/viem-chain.js";
import type { Job, Log } from "./types.js";

/**
 * Zama tally keeper: prepares current-epoch ballots that need rotation draws (entries and proofs
 * from the indexer's catalogue), closes ended epochs and takeover polls, relays the public decryption of their
 * encrypted tallies to `ZamaVotingScheme.submitTally`, finalizes epochs, records takeover tallies and
 * executes successful takeovers. With `ROTATION_GOVERNOR_ADDRESS` it also drives live tokens'
 * rotation rounds (prepare, close, submit the decrypted winner, finalize). Scheduled only with
 * `KEEPER_ENABLED=true` and all of {@link REQUIRED_KEEPER_ENV} set. See README "Tally keeper".
 */
export interface TallyKeeperDeps {
  keeper: KeeperConfig;
  chainId: number;
  indexer?: Pick<IndexerClient, "listTokens" | "catalogEntries" | "agentPicks"> &
    Partial<Pick<IndexerClient, "epochOrgIds" | "activeTokens" | "indexedAt">>;
  log: Log;
  /** Test seams: replace the viem chain or the Zama decryptor. */
  chain?: {
    reader: ChainReader;
    writer: ChainWriter;
    ballots?: BallotReader;
    rotation?: RotationReader;
    rounds?: RoundReader;
    factoryLogs?: FactoryLogReader;
    /** Settle and distribute reads; used only with FEE_VAULT_ADDRESS and DONATION_DISTRIBUTOR_ADDRESS. */
    donation?: DonationReader;
  };
  decryptor?: PublicDecryptor;
}

export const REQUIRED_KEEPER_ENV = [
  "KEEPER_PRIVATE_KEY",
  "ETH_RPC_URL",
  "EPOCH_GOVERNOR_ADDRESS",
  "VOTING_SCHEME_ADDRESS",
  "TAKEOVER_GOVERNOR_ADDRESS",
] as const;

/** Names of the required keeper variables that are not set. */
export function missingKeeperEnv(k: KeeperConfig): string[] {
  const present: Record<(typeof REQUIRED_KEEPER_ENV)[number], boolean> = {
    KEEPER_PRIVATE_KEY: Boolean(k.privateKey),
    ETH_RPC_URL: k.rpcUrls.length > 0,
    EPOCH_GOVERNOR_ADDRESS: Boolean(k.epochGovernor),
    VOTING_SCHEME_ADDRESS: Boolean(k.votingScheme),
    TAKEOVER_GOVERNOR_ADDRESS: Boolean(k.takeoverGovernor),
  };
  return REQUIRED_KEEPER_ENV.filter((n) => !present[n]);
}

export function createTallyKeeperJob(deps: TallyKeeperDeps): Job | null {
  const k = deps.keeper;
  if (!k.enabled) {
    if (k.privateKey && k.rpcUrls.length > 0) deps.log("info", "tally keeper configured but KEEPER_ENABLED is not true; not scheduled");
    return null;
  }
  const missing = missingKeeperEnv(k);
  if (missing.length > 0) {
    deps.log("warn", "KEEPER_ENABLED but required variables are not set; tally keeper not scheduled", { missing });
    return null;
  }
  const epochGovernor = k.epochGovernor!;
  const takeoverGovernor = k.takeoverGovernor!;
  const zamaScheme = k.votingScheme!;

  let chain = deps.chain;
  let decryptor = deps.decryptor;
  try {
    if (!chain || !decryptor) {
      const viemChain = createViemChain({
        chainId: deps.chainId,
        rpcUrls: k.rpcUrls,
        privateKey: k.privateKey!,
        epochGovernor,
        takeoverGovernor,
        rotationGovernor: k.rotationGovernor,
        // A scan from block 0 would take millions of requests, so the fallback needs a start block.
        factory: k.factoryDeployBlock !== undefined ? k.factory : undefined,
        // Tokens (and their ballots) postdate the factory, so ballot log lookups start there.
        fromBlock: k.factoryDeployBlock,
        // Finalize calldata: the indexer's copy of the ballot first (checked against the commitment),
        // so a voted epoch still finalizes when the RPC no longer serves its logs.
        ballotSource: deps.indexer?.epochOrgIds ? (token, epoch) => deps.indexer!.epochOrgIds!(token, epoch) : undefined,
        // The factory's locker holds the LP positions whose uncollected fees mark a token active.
        lockerFactory: k.factory,
        feeVault: k.feeVault,
        donationDistributor: k.donationDistributor,
      });
      const donation =
        k.feeVault && k.donationDistributor
          ? createDonationReader(viemChain.publicClient as never, { epochGovernor, feeVault: k.feeVault, distributor: k.donationDistributor })
          : undefined;
      chain ??= { ...viemChain, donation };
      decryptor ??= createZamaDecryptor({
        chainId: deps.chainId,
        publicClient: viemChain.publicClient,
        rpcUrl: k.rpcUrls[0]!,
        relayerUrl: k.zamaRelayerUrl,
        apiKey: k.zamaRelayerApiKey,
      });
    }
  } catch (err) {
    deps.log("error", "tally keeper not scheduled", { error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return null;
  }
  if (deps.chainId === 1 && !k.zamaRelayerApiKey && !deps.decryptor) {
    deps.log("warn", "ZAMA_RELAYER_API_KEY not set; the mainnet Zama relayer requires one for public decryption");
  }
  if (k.factory && k.factoryDeployBlock === undefined) {
    deps.log("warn", "FACTORY_ADDRESS set without FACTORY_DEPLOY_BLOCK; factory-log token fallback disabled");
  }
  if (!deps.indexer && !chain.factoryLogs) {
    deps.log("warn", "tally keeper has no token source (INDEXER_URL, or FACTORY_ADDRESS with FACTORY_DEPLOY_BLOCK)");
  }

  const donationReader = k.feeVault && k.donationDistributor ? chain.donation : undefined;
  if (!donationReader) {
    deps.log("warn", "FEE_VAULT_ADDRESS or DONATION_DISTRIBUTOR_ADDRESS not set; finalized epochs are not settled or donated by this keeper");
  }
  const donation = donationReader ? createDonationPlanner({ reader: donationReader, zamaScheme, log: deps.log }) : undefined;

  const indexer = deps.indexer;
  if (!indexer) deps.log("warn", "tally keeper has no INDEXER_URL; ballots that need rotation draws are left to other keepers");
  const sources = indexer
    ? {
        // The ballot's own version: rotation rounds keep the epoch-start one after a mid-week version.
        entries: { entries: (at: { bucket: number; index: number }[], catalog?: { root: Hex }) => indexer.catalogEntries(at, catalog?.root) },
        picks: { picks: (label: string, epoch: bigint, region: string) => indexer.agentPicks(label, epoch, region) },
      }
    : undefined;
  const ballots = sources && chain.ballots ? createBallotPreparer({ reader: chain.ballots, ...sources }) : undefined;

  let rotation: KeeperDeps["rotation"];
  if (k.rotationGovernor) {
    if (chain.rotation) {
      rotation = {
        governor: k.rotationGovernor,
        reader: chain.rotation,
        // Without the indexer's catalogue, rounds are still closed and finalized, not prepared.
        rounds: sources && chain.rounds ? createRoundPreparer({ reader: chain.rounds, ...sources }) : undefined,
        lookbackRounds: k.lookbackRounds,
      };
    } else {
      deps.log("warn", "ROTATION_GOVERNOR_ADDRESS set but the chain has no rotation reader; rotation rounds not kept");
    }
  }

  const keeper = createKeeper({
    reader: chain.reader,
    writer: chain.writer,
    decryptor,
    ballots,
    tokens: createTokenSource({ indexer: deps.indexer, factoryLogs: chain.factoryLogs, factoryDeployBlock: k.factoryDeployBlock, log: deps.log }),
    epochGovernor,
    takeoverGovernor,
    rotation,
    zamaScheme,
    dryRun: k.dryRun,
    maxTxPerRun: k.maxTxPerRun,
    lookbackEpochs: k.lookbackEpochs,
    activity: indexer?.activeTokens
      ? { activeTokens: (e, t) => indexer.activeTokens!(e, t), indexedAt: indexer.indexedAt ? () => indexer.indexedAt!() : undefined }
      : undefined,
    idleEpochs: k.idleEpochs,
    maxIndexerLagSeconds: k.maxIndexerLagSeconds,
    donation,
    log: deps.log,
  });
  deps.log("info", "tally keeper ready", {
    keeper: chain.writer.account,
    chainId: deps.chainId,
    dryRun: k.dryRun,
    maxTxPerRun: k.maxTxPerRun,
    lookbackEpochs: k.lookbackEpochs,
    idleEpochs: k.idleEpochs,
    rotationRounds: rotation ? (rotation.rounds ? "prepare, close, finalize" : "close, finalize") : "off",
    donations: donation ? "settle, distribute" : "off",
  });

  return {
    name: "tally-keeper",
    intervalMs: k.intervalMs,
    async run() {
      const summary = await keeper.run();
      deps.log("info", "tally keeper run", { ...summary });
    },
  };
}
