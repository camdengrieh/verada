/**
 * "Send this epoch's donation": every step that turns an ended epoch's fees into its donation is
 * permissionless (close the vote, finalize the winner, `FeeVault.settle`, then
 * `DonationDistributor.distribute`), so anyone can push an epoch through when the platform keeper has
 * not. The indexer only says which epochs to look at; each epoch is planned from chain state with the
 * SDK's `planDonation`, the same plan the keeper runs, because the indexer may lag.
 *
 * The tally decryption is the one step this page does not do. On mainnet, Zama's relayer serves a
 * public decryption only with an API key, which the keeper holds server side and a static bundle
 * cannot; the card waits for the keeper there (see `docs/ARCHITECTURE.md`, "Weekly payout").
 */
import {
  createDonationReader,
  donationCall,
  epochFinalizeNeedsOptions,
  planDonation,
  type DonationReadClient,
  type DonationStage,
  type DonationState,
  type DonationStep,
} from "@varada/sdk";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { isHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import type { AppConfig } from "./config";
import type { DataDeps } from "./data";
import { durationText } from "./epoch-timing";

export interface DonationPushAddresses {
  epochGovernor: Address;
  feeVault: Address;
  distributor: Address;
  zamaScheme: Address;
}

/** The addresses the card needs, or null (card hidden) when the governor, vault or distributor is unset. */
export function donationAddresses(cfg: AppConfig): DonationPushAddresses | null {
  if (!cfg.governorAddress || !cfg.vaultAddress || !cfg.donationDistributorAddress) return null;
  return {
    epochGovernor: cfg.governorAddress,
    feeVault: cfg.vaultAddress,
    distributor: cfg.donationDistributorAddress,
    // Without a configured scheme no poll is taken for the Zama one (the plan waits on its tally).
    zamaScheme: cfg.votingSchemeAddress ?? zeroAddress,
  };
}

/** One ended week, planned from chain state. */
export interface PlannedWeek {
  epoch: bigint;
  state: DonationState;
  step: DonationStep;
  /** The week had ballots, so it is closed and its tally decrypted before it is finalized. */
  hasBallots: boolean;
}

/**
 * Ended weeks the card plans per load (the newest ones), so a token's RPC reads stay bounded.
 * Weeks that cannot move stay undonated in the indexer; taking the newest keeps them from filling
 * every slot, and an older sendable week comes into range once the newer ones are donated.
 */
export const MAX_WEEKS = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/** Weeks to plan, oldest first. `indexed`: they come from the indexer, which saw fees for them. */
export interface CandidateWeeks {
  weeks: bigint[];
  indexed: boolean;
}

/**
 * The newest {@link MAX_WEEKS} ended weeks (`epoch < current`) the indexer shows with fees for the
 * cause and no donation yet, oldest first (`GET /api/epochs/:token`, newest 100). When the indexer
 * cannot answer, last week, unverified (`indexed: false`).
 */
export async function candidateWeeks(deps: DataDeps, token: Address, current: bigint): Promise<CandidateWeeks> {
  let body: unknown;
  try {
    body = await deps.indexer.get(`/api/epochs/${token}`, { limit: 100 });
  } catch {
    return { weeks: current > 0n ? [current - 1n] : [], indexed: false };
  }
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const weeks: bigint[] = [];
  for (const row of items) {
    if (!isRecord(row)) continue;
    const epoch = big(row.epoch);
    if (epoch === null || epoch >= current) continue;
    if (row.donatedAt !== null && row.donatedAt !== undefined) continue;
    const attributed = big(row.causeAttributed) ?? 0n;
    const settled = big(row.settledAmount) ?? 0n;
    if (attributed > 0n || settled > 0n) weeks.push(epoch);
  }
  return { weeks: [...new Set(weeks)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(-MAX_WEEKS), indexed: true };
}

/** The ballot's org ids from the indexer (`optionOrgIds`); the plan checks them against the chain. */
async function ballotOrgIds(deps: DataDeps, token: Address, epoch: bigint): Promise<Hex[] | undefined> {
  try {
    const body = await deps.indexer.get(`/api/epochs/${token}/${epoch}`);
    const ids = isRecord(body) && Array.isArray(body.optionOrgIds) ? body.optionOrgIds : [];
    return ids.length > 0 && ids.every((x) => typeof x === "string" && isHex(x) && x.length === 66) ? (ids as Hex[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Plans one week from chain state (the indexer only supplies the ballot's org ids, when needed). */
export async function planWeek(deps: DataDeps, addrs: DonationPushAddresses, token: Address, epoch: bigint): Promise<PlannedWeek> {
  const reader = createDonationReader(deps.chain() as unknown as DonationReadClient, addrs);
  const state = await reader.read(token, epoch);
  const g = state.governor;
  const hasBallots = epochFinalizeNeedsOptions(g);
  const orgIds = !g.finalized && hasBallots && g.closed ? await ballotOrgIds(deps, token, epoch) : undefined;
  return { epoch, state, step: planDonation(state, { zamaScheme: addrs.zamaScheme, orgIds }), hasBallots };
}

/** Which planned week the card shows first: one with a step to send, then a wait, then a block. */
const rank = (step: DonationStep) => (step.type === "send" ? 0 : step.type === "wait" || step.type === "decrypt" ? 1 : step.type === "blocked" ? 2 : 3);

/**
 * The ended week the card offers: the oldest with a step anyone can send now, else the oldest
 * waiting (on the keeper's decryption, on fees) or blocked one, so a week stuck for good never
 * hides a newer one that can move. Null when none has a step left, or the token is not a weekly
 * token of this governor.
 *
 * Without the indexer, last week is offered only once the chain shows fees for it (or it is
 * finalized, when settling decides): it may have none, and finalizing would then cost the visitor
 * gas for nothing.
 */
export async function nextWaitingWeek(deps: DataDeps, addrs: DonationPushAddresses, token: Address): Promise<PlannedWeek | null> {
  const current = (await deps.chain().readContract({ address: addrs.epochGovernor, abi: epochGovernorAbi, functionName: "currentEpoch" })) as bigint;
  const { weeks, indexed } = await candidateWeeks(deps, token, current);
  let best: PlannedWeek | null = null;
  for (const epoch of weeks) {
    const week = await planWeek(deps, addrs, token, epoch);
    if (week.step.type === "blocked" && week.step.reason === "not-registered") return null;
    if (week.step.type === "done") continue;
    if (!indexed && !week.state.governor.finalized && week.state.epochPool === 0n) continue;
    if (week.step.type === "send") return week;
    if (!best || rank(week.step) < rank(best.step)) best = week;
  }
  return best;
}

/** The wagmi `writeContract` request for a planned step, or null when nothing is to be sent. */
export function donationRequest(
  step: DonationStep,
  addrs: DonationPushAddresses,
  chainId: number,
): { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; chainId: number } | null {
  if (step.type !== "send") return null;
  return { ...donationCall(step, addrs), chainId };
}

/** The button for a step: a finalize past the tally grace says that the default charity gets the week. */
export function stepLabel(step: Extract<DonationStep, { type: "send" }>, charity: string, defaultCharity: string): string {
  if (step.fallback === "tally-timeout") return `Give this epoch to ${defaultCharity}`;
  return stageLabel(step.stage, charity);
}

/** What happens on a finalize past the tally grace, which overrides the vote. */
/** `tallyGraceSeconds`: the governor's `tallyGrace` (owner-set; 14 days by default), shown as read. */
export function fallbackText(defaultCharity: string, tallyGraceSeconds?: number): string {
  const tallyGraceText = tallyGraceSeconds === undefined ? "time" : durationText(tallyGraceSeconds);
  return (
    `This epoch's votes were never decrypted, and the ${tallyGraceText} the platform has to do it are over. Finalizing now does not ` +
    `count the votes: the epoch goes to the default charity, ${defaultCharity}, whatever the votes said.`
  );
}

/** What each step does, in plain words. */
export function stageLabel(stage: DonationStage, charity: string): string {
  switch (stage) {
    case "close":
      return "Close the vote";
    case "tally":
      return "Decrypt the tally";
    case "finalize":
      return "Finalize the winner";
    case "settle":
      return "Move the epoch's fees to the donation contract";
    case "distribute":
      return `Send the donation to ${charity}`;
  }
}

const when = (until: bigint | undefined, format: (s: number) => string) => (until === undefined ? "later" : format(Number(until)));

/** Why the card waits, in plain words. `format` renders a timestamp in seconds. */
export function waitText(step: DonationStep, format: (seconds: number) => string): string | null {
  if (step.type === "decrypt") {
    return (
      "Waiting for the tally to be decrypted. The votes are encrypted; the platform keeper asks Zama to decrypt the totals " +
      "and puts them on chain. This page cannot do that step (Zama's relayer needs the keeper's API key). Once the tally " +
      "is on chain, the next step is open to anyone."
    );
  }
  if (step.type !== "wait") return null;
  switch (step.reason) {
    case "epoch-not-ended":
      return `This epoch is still running. It ends at ${when(step.until, format)}.`;
    case "tally-decryption":
      return "Waiting for the tally to be decrypted. The platform keeper relays it from Zama; this page cannot.";
    case "tally-other-scheme":
      return `This epoch's votes were cast on a voting contract the platform does not decrypt. From ${when(step.until, format)} the epoch can be finalized on the default charity.`;
    case "fees-pending":
      return (
        "Some of this epoch's fees are still on their way to the vault (trading fees not yet collected or converted to USDC). " +
        `Moving the fees now would leave those for a later epoch, so the vault accepts it once they are in, or from ${when(step.until, format)} at the latest.`
      );
  }
}

/** Why nothing can be sent right now, in plain words. */
export function blockedText(step: DonationStep, charity: string): string | null {
  if (step.type !== "blocked") return null;
  switch (step.reason) {
    case "not-registered":
      return "This token does not give through epoch pools.";
    case "fee-vault-not-registered":
      return "The fee vault this app is configured with does not know this token, so its fees cannot be moved from here.";
    case "no-default-cause":
      return "Nobody voted for a charity this epoch and the platform has not set a default charity, so there is no winner yet. The epoch can be finalized once one is set.";
    case "ballot-options-unavailable":
      return "The charities on this epoch's ballot could not be loaded from the indexer, so the winner cannot be finalized from this page right now. The platform keeper reads them from the chain.";
    case "org-not-active":
      return `Endaoment no longer lists ${charity} as active, so the donation cannot be sent. The money stays in the donation contract until this is resolved.`;
    case "org-address-mismatch":
      return `The address on record for ${charity} no longer matches Endaoment's, so the donation cannot be sent. The money stays in the donation contract until this is resolved.`;
    case "settle-reverts":
      return `Moving the fees would fail on chain right now${step.error ? ` (${step.error})` : ""}.`;
    case "distribute-reverts":
      return `Sending the donation would fail on chain right now${step.error ? ` (${step.error})` : ""}.`;
  }
}
