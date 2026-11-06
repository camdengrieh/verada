/**
 * Turning a finished week's fees into a donation: the planning shared by the publisher's keeper and
 * the web app's "Send this week's donation" card. Every step is permissionless on chain:
 *
 *   EpochGovernor.closeEpoch -> (public decryption + ZamaVotingScheme.submitTally)
 *   -> EpochGovernor.finalizeEpoch(token, epoch, orgIds) -> FeeVault.settle(token, epoch)
 *   -> DonationDistributor.distribute(token, epoch) -> done.
 *
 * `planEpochGovernor` is the governor part exactly as the keeper has always run it.
 * `planDonation` decides the next step of the whole chain for one ended epoch from chain state
 * read by `createDonationReader`; `donationCall` turns a `send` step into a contract call for any
 * viem or wagmi writer.
 */
import { ContractFunctionRevertedError, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { donationDistributorAbi, epochGovernorAbi, feeVaultAbi, zamaVotingSchemeAbi } from "./abis/index.js";
import { ballotCommitment } from "./catalog.js";

// ---------------------------------------------------------------- governor part (shared with the keeper)

/** `EpochGovernor` state of one `(token, epoch)`. `scheme` is zero until the epoch opens. */
export interface EpochGovernorState {
  opened: boolean;
  closed: boolean;
  finalized: boolean;
  voterCount: bigint;
  scheme: Address;
  /**
   * `EpochGovernor.closeFailed`: the scheme refused `requestTally`, so `closeEpoch` may be sent
   * again. Read by the donation reader; `planEpochGovernor` ignores it.
   */
  closeFailed?: boolean;
}

/** `IVotingScheme.tallyOf`. */
export interface VoteTally {
  isFinal: boolean;
  counts: readonly bigint[];
}

/** The governor step for an ended epoch, before calldata is built. */
export type GovernorStep =
  | { type: "none"; reason: string; terminal: boolean }
  | { type: "closeEpoch" }
  /** `needsOptions`: the epoch has ballots, so `orgIds` must be the ballot's org ids. */
  | { type: "finalizeEpoch"; needsOptions: boolean }
  /** Decrypt the tally publicly and `submitTally(governor, token, epoch, ...)` on `scheme`. */
  | { type: "decrypt"; scheme: Address };

/** Finalizing an epoch with ballots needs its options (org ids) as calldata. */
export const epochFinalizeNeedsOptions = (v: Pick<EpochGovernorState, "opened" | "voterCount">) => v.opened && v.voterCount > 0n;

/** The tally is only needed once the poll has ballots and is closed. */
export const epochNeedsTally = (v: EpochGovernorState) => v.opened && v.closed && v.voterCount > 0n && !v.finalized;

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Next governor step for an ended epoch (`epoch < currentEpoch`) of a registered token.
 *
 * - finalized: nothing, ever again.
 * - never opened, or opened without ballots: `finalizeEpoch` (the default cause wins; reverts
 *   `NoVotes` while none is set). Such an epoch is never closed, which saves a public decryption.
 * - opened with ballots, not closed: `closeEpoch` (makes the tallies publicly decryptable).
 * - closed, tally not final: decrypt the tally and `submitTally`, if the epoch's scheme is the
 *   configured Zama scheme.
 * - closed, tally final: `finalizeEpoch` with the ballot's org ids.
 */
export function planEpochGovernor(v: EpochGovernorState, tally: VoteTally | undefined, ctx: { zamaScheme: Address }): GovernorStep {
  if (v.finalized) return { type: "none", reason: "finalized", terminal: true };
  if (!v.opened || v.voterCount === 0n) return { type: "finalizeEpoch", needsOptions: false };
  if (!v.closed) return { type: "closeEpoch" };
  if (!tally) return { type: "none", reason: "tally not read", terminal: false };
  if (tally.isFinal) return { type: "finalizeEpoch", needsOptions: true };
  if (v.scheme === zeroAddress || !sameAddr(v.scheme, ctx.zamaScheme)) return { type: "none", reason: "epoch scheme is not the Zama scheme", terminal: false };
  return { type: "decrypt", scheme: v.scheme };
}

// ---------------------------------------------------------------- the whole chain

/** Result of simulating a permissionless call (`eth_call`): ok, or the decoded custom error name. */
export type CallCheck = { ok: true } | { ok: false; error?: string };

/** Everything `planDonation` decides from, read by {@link createDonationReader}. */
export interface DonationState {
  token: Address;
  epoch: bigint;
  /** Latest block timestamp, in seconds. */
  now: bigint;
  currentEpoch: bigint;
  /** `EpochGovernor.epochStart(epoch)`, seconds. */
  epochStart: bigint;
  /** `EpochGovernor.epochStart(epoch + 1)`: when the epoch ended, seconds. */
  epochEnd: bigint;
  /** `EpochGovernor.isRegistered`: false for live tokens (they have no weekly epochs). */
  registered: boolean;
  governor: EpochGovernorState;
  /** `tallyOf` on the epoch's scheme; read only when {@link epochNeedsTally}. */
  tally?: VoteTally;
  /** `EpochGovernor.TALLY_GRACE`, seconds. */
  tallyGrace: bigint;
  /** `EpochGovernor.defaultCause`: wins an epoch nobody voted in (zero: none set). */
  defaultCause: Hex;
  /** `EpochGovernor.winningCause` (zero until finalized). */
  winningCause: Hex;
  /** `EpochGovernor.ballotCommitment`: hash and count of the ballot's org ids. */
  ballot: { commitment: Hex; optionCount: number };
  /** `FeeVault.isRegistered`. */
  feeVaultRegistered: boolean;
  /** `FeeVault.settled`. */
  settled: boolean;
  /** `FeeVault.causePoolOf(token, epoch)`: the epoch's cause pool not yet settled. */
  epochPool: bigint;
  /** `FeeVault.SETTLE_GRACE`, seconds. */
  settleGrace: bigint;
  /** Simulated `FeeVault.settle`; read once the epoch is finalized and not settled. */
  settleCheck?: CallCheck;
  /** `DonationDistributor.pending`. */
  pending: bigint;
  /** `DonationDistributor.distributed`. */
  distributed: boolean;
  /** Simulated `DonationDistributor.distribute`; read once settled and not distributed. */
  distributeCheck?: CallCheck;
}

/** Steps in chain order. `tally` is the public decryption plus `submitTally`. */
export const DONATION_STAGES = ["close", "tally", "finalize", "settle", "distribute"] as const;
export type DonationStage = (typeof DONATION_STAGES)[number];

export type DonationContract = "governor" | "feeVault" | "distributor" | "scheme";

export type WaitReason =
  /** The epoch is still running (`until`: its end). */
  | "epoch-not-ended"
  /** The tally needs a public decryption, which the platform keeper relays. */
  | "tally-decryption"
  /** The epoch's poll is on a scheme other than the Zama scheme (`until`: the tally grace end). */
  | "tally-other-scheme"
  /** The epoch's fees are not all in the vault yet (`until`: the settle grace end). */
  | "fees-pending";

export type BlockedReason =
  /** Not a weekly token of this governor (live tokens, or a wrong address). */
  | "not-registered"
  /** The fee vault does not know the token (a misconfigured vault address). */
  | "fee-vault-not-registered"
  /** Nobody voted (or every count is zero) and the governor has no default cause: `NoVotes`. */
  | "no-default-cause"
  /** The epoch has ballots and its org ids are unknown, or do not match the ballot commitment. */
  | "ballot-options-unavailable"
  /** `OrgNotActive`: Endaoment no longer lists the winning org as active. */
  | "org-not-active"
  /** `OrgAddressMismatch`: the registry's address for the org is not Endaoment's. */
  | "org-address-mismatch"
  /** Any other revert of a simulated settle or distribute (`error`: its name, when decoded). */
  | "settle-reverts"
  | "distribute-reverts";

export type DonationStep =
  | { type: "send"; stage: DonationStage; contract: DonationContract; functionName: string; args: readonly unknown[] }
  | { type: "decrypt"; stage: "tally"; scheme: Address; token: Address; scope: bigint }
  | { type: "wait"; stage: DonationStage; reason: WaitReason; until?: bigint }
  | { type: "done"; reason: "donated" | "nothing-to-donate" }
  | { type: "blocked"; stage: DonationStage | "none"; reason: BlockedReason; error?: string };

export interface PlanDonationContext {
  /** The Zama voting scheme; polls on any other scheme are never decrypted. */
  zamaScheme: Address;
  /**
   * The ballot's org ids, in order (indexer `optionOrgIds` or the `BallotPrepared` log). Needed
   * only to finalize an epoch with ballots; checked against `ballotCommitment` here and by the
   * governor again, so a wrong list can only make the plan stop or the call revert.
   */
  orgIds?: readonly Hex[];
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const isZero32 = (h: Hex) => /^0x0*$/.test(h);

/**
 * Next step for one ended epoch of one weekly token, from chain state alone.
 *
 * - Distributed: done ("donated").
 * - Not registered with the governor: blocked. The epoch still running: wait for its end.
 * - Not finalized: the governor step ({@link planEpochGovernor}). A close the scheme refused
 *   (`closeFailed`) is sent again. After `TALLY_GRACE` past the epoch's end without a final tally
 *   the governor applies its default cause, so the plan finalizes instead of waiting longer.
 *   Finalizing with no winning vote needs a default cause (blocked otherwise, `NoVotes`), and
 *   finalizing with ballots needs org ids matching the ballot commitment.
 * - Finalized, not settled: `settle` when its simulation passes. `FeesPending` waits until
 *   `SETTLE_GRACE` after the epoch's end. `NothingToSettle` means the epoch's pool is empty: done
 *   ("nothing-to-donate").
 * - Settled, not distributed: `distribute` when its simulation passes. `OrgNotActive` and
 *   `OrgAddressMismatch` are blocked (an owner or Endaoment must act), never retried as such.
 */
export function planDonation(s: DonationState, ctx: PlanDonationContext): DonationStep {
  const { token, epoch } = s;
  if (s.distributed) return { type: "done", reason: "donated" };
  if (!s.registered) return { type: "blocked", stage: "none", reason: "not-registered" };
  if (epoch >= s.currentEpoch) return { type: "wait", stage: "close", reason: "epoch-not-ended", until: s.epochEnd };

  const g = s.governor;
  if (!g.finalized) {
    const governor = (functionName: string, args: readonly unknown[], stage: DonationStage): DonationStep => ({
      type: "send",
      stage,
      contract: "governor",
      functionName,
      args,
    });
    const tallyTimedOut = s.now >= s.epochEnd + s.tallyGrace;
    const finalize = (needsOptions: boolean, timedOut: boolean): DonationStep => {
      if (!needsOptions) {
        if (isZero32(s.defaultCause)) return { type: "blocked", stage: "finalize", reason: "no-default-cause" };
        return governor("finalizeEpoch", [token, epoch, []], "finalize");
      }
      // A final tally with no vote counted falls back to the default cause too.
      if (!timedOut && s.tally && s.tally.counts.every((c) => c === 0n) && isZero32(s.defaultCause)) {
        return { type: "blocked", stage: "finalize", reason: "no-default-cause" };
      }
      if (timedOut) {
        // The governor ignores orgIds once the tally grace has passed without a valid tally.
        if (isZero32(s.defaultCause)) return { type: "blocked", stage: "finalize", reason: "no-default-cause" };
        return governor("finalizeEpoch", [token, epoch, matchingOrgIds(s, ctx.orgIds) ?? []], "finalize");
      }
      const orgIds = matchingOrgIds(s, ctx.orgIds);
      if (!orgIds) return { type: "blocked", stage: "finalize", reason: "ballot-options-unavailable" };
      return governor("finalizeEpoch", [token, epoch, orgIds], "finalize");
    };

    if (g.opened && g.voterCount > 0n && g.closed && g.closeFailed) return governor("closeEpoch", [token, epoch], "close");
    const step = planEpochGovernor(g, s.tally, ctx);
    switch (step.type) {
      case "closeEpoch":
        return governor("closeEpoch", [token, epoch], "close");
      case "finalizeEpoch":
        return finalize(step.needsOptions, false);
      case "decrypt":
        if (tallyTimedOut) return finalize(true, true);
        return { type: "decrypt", stage: "tally", scheme: step.scheme, token, scope: epoch };
      case "none":
        if (tallyTimedOut) return finalize(true, true);
        return {
          type: "wait",
          stage: "tally",
          reason: s.tally ? "tally-other-scheme" : "tally-decryption",
          until: s.epochEnd + s.tallyGrace,
        };
    }
  }

  if (!s.settled) {
    if (!s.feeVaultRegistered) return { type: "blocked", stage: "settle", reason: "fee-vault-not-registered" };
    const graceEnd = s.epochEnd + s.settleGrace;
    const settle: DonationStep = { type: "send", stage: "settle", contract: "feeVault", functionName: "settle", args: [token, epoch] };
    const c = s.settleCheck;
    if (!c) {
      // Not simulated: decide from the pool alone (settling may still bring fees in).
      if (s.epochPool > 0n) return settle;
      return s.now < graceEnd ? { type: "wait", stage: "settle", reason: "fees-pending", until: graceEnd } : { type: "done", reason: "nothing-to-donate" };
    }
    if (c.ok) return settle;
    if (c.error === "FeesPending") return { type: "wait", stage: "settle", reason: "fees-pending", until: graceEnd };
    if (c.error === "NothingToSettle") return { type: "done", reason: "nothing-to-donate" };
    return { type: "blocked", stage: "settle", reason: "settle-reverts", ...(c.error ? { error: c.error } : {}) };
  }

  // Settling an empty pool reverts, so a settled epoch always has funds pending; this is defensive.
  if (s.pending === 0n) return { type: "done", reason: "nothing-to-donate" };
  const c = s.distributeCheck;
  if (!c || c.ok) return { type: "send", stage: "distribute", contract: "distributor", functionName: "distribute", args: [token, epoch] };
  if (c.error === "OrgNotActive") return { type: "blocked", stage: "distribute", reason: "org-not-active", error: c.error };
  if (c.error === "OrgAddressMismatch") return { type: "blocked", stage: "distribute", reason: "org-address-mismatch", error: c.error };
  return { type: "blocked", stage: "distribute", reason: "distribute-reverts", ...(c.error ? { error: c.error } : {}) };
}

/** `orgIds` when they match the ballot commitment, else undefined. */
function matchingOrgIds(s: DonationState, orgIds: readonly Hex[] | undefined): Hex[] | undefined {
  if (!orgIds || orgIds.length !== s.ballot.optionCount) return undefined;
  if (ballotCommitment(orgIds) !== s.ballot.commitment.toLowerCase()) return undefined;
  return [...orgIds];
}

/** Stages still ahead of (and including) the step's, for an epoch that has (or lacks) ballots. */
export function remainingStages(step: DonationStep, hasBallots: boolean): DonationStage[] {
  if (step.type === "done") return [];
  const all = DONATION_STAGES.filter((x) => hasBallots || (x !== "close" && x !== "tally"));
  if (step.stage === "none") return all;
  const i = all.indexOf(step.stage);
  return i < 0 ? all : all.slice(i);
}

// ---------------------------------------------------------------- calls

export interface DonationAddresses {
  epochGovernor: Address;
  feeVault: Address;
  distributor: Address;
}

/** `{ address, abi, functionName, args }` of a `send` step, for any viem or wagmi writer. */
export function donationCall(
  step: Extract<DonationStep, { type: "send" }>,
  addrs: DonationAddresses & { scheme?: Address },
): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  switch (step.contract) {
    case "governor":
      return { address: addrs.epochGovernor, abi: epochGovernorAbi as Abi, functionName: step.functionName, args: step.args };
    case "feeVault":
      return { address: addrs.feeVault, abi: feeVaultAbi as Abi, functionName: step.functionName, args: step.args };
    case "distributor":
      return { address: addrs.distributor, abi: donationDistributorAbi as Abi, functionName: step.functionName, args: step.args };
    case "scheme":
      if (!addrs.scheme) throw new Error("no voting scheme address");
      return { address: addrs.scheme, abi: zamaVotingSchemeAbi as Abi, functionName: step.functionName, args: step.args };
  }
}

type RevertLike = { name?: unknown; data?: { errorName?: string }; signature?: string; reason?: string; cause?: unknown };

/**
 * The `ContractFunctionRevertedError` in an error's cause chain, if any. Matched by name as well as
 * class: the client may come from another copy of viem (each workspace package can resolve its
 * own), and `instanceof` fails across copies.
 */
function findRevert(err: unknown): RevertLike | undefined {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 32; depth++) {
    if (e instanceof ContractFunctionRevertedError || (e as RevertLike).name === "ContractFunctionRevertedError") return e as RevertLike;
    e = (e as RevertLike).cause;
  }
  return undefined;
}

/** Whether an error is a contract revert (as opposed to an RPC or network failure). */
export function isRevertError(err: unknown): boolean {
  return findRevert(err) !== undefined;
}

/** Decoded custom error name of a revert, if any (arguments are dropped). */
export function revertErrorName(err: unknown): string | undefined {
  const r = findRevert(err);
  return r ? (r.data?.errorName ?? r.signature ?? r.reason) : undefined;
}

// ---------------------------------------------------------------- reader

/** The viem `PublicClient` methods the reader uses (concurrent `readContract` calls batch into one multicall). */
export interface DonationReadClient {
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  simulateContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(args: { blockTag: "latest" }): Promise<{ timestamp: bigint }>;
}

export interface DonationReader {
  read(token: Address, epoch: bigint): Promise<DonationState>;
}

/**
 * Reads exactly the state {@link planDonation} needs: one batch of views (concurrent, so a client
 * with JSON-RPC or multicall batching sends it at once), then, depending on it, the epoch's tally
 * and a simulated `settle` or `distribute` (`eth_call`, so the plan sees exactly what the
 * transaction would hit, including fees `settle` would bring in first).
 */
export function createDonationReader(client: DonationReadClient, addrs: DonationAddresses): DonationReader {
  const { epochGovernor: eg, feeVault: fv, distributor: dd } = addrs;
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const gov = (fn: string, args: readonly unknown[] = []) => read<unknown>(eg, epochGovernorAbi as Abi, fn, args);
  const check = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<CallCheck> => {
    try {
      await client.simulateContract({ address, abi, functionName, args } as never);
      return { ok: true };
    } catch (err) {
      if (!isRevertError(err)) throw err;
      const name = revertErrorName(err);
      return name !== undefined ? { ok: false, error: name } : { ok: false };
    }
  };

  return {
    async read(token, epoch) {
      const te = [token, epoch] as const;
      const [
        block,
        currentEpoch,
        registered,
        opened,
        closed,
        closeFailed,
        finalized,
        voterCount,
        scheme,
        epochStart,
        epochEnd,
        tallyGrace,
        defaultCause,
        winningCause,
        commitment,
        feeVaultRegistered,
        settled,
        epochPool,
        settleGrace,
        pending,
        distributed,
      ] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        gov("currentEpoch") as Promise<bigint>,
        gov("isRegistered", [token]) as Promise<boolean>,
        gov("isOpened", te) as Promise<boolean>,
        gov("isClosed", te) as Promise<boolean>,
        gov("closeFailed", te) as Promise<boolean>,
        gov("isFinalized", te) as Promise<boolean>,
        gov("voterCount", te) as Promise<bigint>,
        gov("epochScheme", te) as Promise<Address>,
        gov("epochStart", [epoch]) as Promise<bigint>,
        gov("epochStart", [epoch + 1n]) as Promise<bigint>,
        gov("TALLY_GRACE") as Promise<bigint>,
        gov("defaultCause") as Promise<Hex>,
        gov("winningCause", te) as Promise<Hex>,
        gov("ballotCommitment", te) as Promise<readonly [Hex, number | bigint]>,
        read<boolean>(fv, feeVaultAbi as Abi, "isRegistered", [token]),
        read<boolean>(fv, feeVaultAbi as Abi, "settled", te),
        read<bigint>(fv, feeVaultAbi as Abi, "causePoolOf", te),
        read<bigint>(fv, feeVaultAbi as Abi, "SETTLE_GRACE"),
        read<bigint>(dd, donationDistributorAbi as Abi, "pending", te),
        read<boolean>(dd, donationDistributorAbi as Abi, "distributed", te),
      ]);
      const governor: EpochGovernorState = { opened, closed, finalized, voterCount, scheme, closeFailed };
      const state: DonationState = {
        token,
        epoch,
        now: block.timestamp,
        currentEpoch,
        epochStart,
        epochEnd,
        registered,
        governor,
        tallyGrace,
        defaultCause: defaultCause ?? ZERO32,
        winningCause: winningCause ?? ZERO32,
        ballot: { commitment: commitment[0], optionCount: Number(commitment[1]) },
        feeVaultRegistered,
        settled,
        epochPool,
        settleGrace,
        pending,
        distributed,
      };
      if (distributed || !registered || epoch >= currentEpoch) return state;

      if (epochNeedsTally(governor) && scheme !== zeroAddress) {
        const [isFinal, counts] = await read<readonly [boolean, readonly bigint[]]>(scheme, zamaVotingSchemeAbi as Abi, "tallyOf", [eg, token, epoch]);
        state.tally = { isFinal, counts };
      } else if (finalized && !settled && feeVaultRegistered) {
        state.settleCheck = await check(fv, feeVaultAbi as Abi, "settle", te);
      } else if (finalized && settled && pending > 0n) {
        state.distributeCheck = await check(dd, donationDistributorAbi as Abi, "distribute", te);
      }
      return state;
    },
  };
}
