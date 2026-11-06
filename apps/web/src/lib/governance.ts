/**
 * Pure mappers and loaders for the governance page: epoch clock and status, ballot options for the
 * library's `BallotList`, tally results, and the donation history. Everything address-keyed
 * (weights, "have I voted") is read through `createAccountClient` by the caller; nothing here sends
 * an address to the indexer.
 */
import { CATEGORIES, EPOCH_LENGTH, REGIONS, USDC_DECIMALS, causeIdOfOrg, swarmGatewayUrl } from "@varada/sdk";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { isCauseName, type CauseName } from "@varada/ui/components/varada/cause-icon";
import type { BallotOptionData, BallotSource } from "@varada/ui/components/varada/ballot-option";
import type { Donation } from "@varada/ui/components/varada/donation-timeline";
import type { LeaderboardEntry } from "@varada/ui/components/varada/cause-leaderboard";
import type { Address, Hex, PublicClient } from "viem";
import type { AgentReport } from "./agents";
import type { AppConfig } from "./config";
import type { DataDeps } from "./data";
import type { ActivityItem, CatalogOrg, CauseSummary, EpochDetail, OptionSource, PollSummary, TokenFocus } from "./indexer";
import { txUrl } from "./explorer";

// ---- causes, regions and option labels

const CAUSE_BY_SLUG = new Map<string, CauseName>(
  CATEGORIES.map((c) => [c.slug, c.ensLabel && isCauseName(c.ensLabel) ? c.ensLabel : "other"] as const),
);

/** The library's cause name for a catalogue category slug (`disaster-relief` gives `disaster`); `other` when unknown. */
export function causeNameForSlug(slug: string | null | undefined): CauseName {
  return (slug && CAUSE_BY_SLUG.get(slug)) || "other";
}

/** The category an org is shown under: one inside the token's focus when it has several, else its first. */
export function orgCause(org: Pick<CatalogOrg, "categories"> | undefined, focus?: Pick<TokenFocus, "categories"> | null): CauseName {
  if (!org || org.categories.length === 0) return "other";
  const inFocus = focus?.categories.length ? org.categories.find((c) => focus.categories.includes(c)) : undefined;
  return causeNameForSlug(inFocus ?? org.categories[0]);
}

/** "Africa", "Africa + 2 more" or "Global" for an org's regions. */
export function orgRegionLabel(org: Pick<CatalogOrg, "regions"> | undefined): string {
  const slugs = org?.regions ?? [];
  const first = REGIONS.find((r) => r.slug === slugs[0]);
  if (!first) return "Global";
  return slugs.length > 1 ? `${first.label} + ${slugs.length - 1} more` : first.label;
}

const SOURCE_ORDER: OptionSource[] = ["pinned", "curated", "rotation"];

/** "2 pinned, 3 curated, 27 rotation", counting only known sources; null unless every source is known. */
export function ballotMakeup(sources: readonly (OptionSource | null)[]): string | null {
  if (sources.length === 0 || sources.some((s) => s === null)) return null;
  return SOURCE_ORDER.map((k) => [k, sources.filter((s) => s === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

/**
 * Source of each option. Before the ballot is prepared the options are the token's pins; after,
 * the indexer's per-option sources (null entries when it does not report them, such as an older
 * indexer or the chain fallback).
 */
export function optionSources(prepared: boolean, options: readonly string[], detail: Pick<EpochDetail, "optionSources"> | null): (OptionSource | null)[] {
  if (!prepared) return options.map(() => "pinned");
  const given = detail?.optionSources;
  if (!given || given.length !== options.length) return options.map(() => null);
  return given.map((s) => s ?? null);
}

export interface BallotOptionInputs {
  /** Cause ids in ballot order (the index is the choice). */
  options: readonly string[];
  sources: readonly (OptionSource | null)[];
  /** Catalogue orgs by lowercase cause id. */
  orgs?: ReadonlyMap<string, CatalogOrg>;
  /** Registry causes by lowercase cause id (names for orgs that already won once). */
  causes?: ReadonlyMap<string, Pick<CauseSummary, "name">>;
  /** Curator score (0-100) by lowercase cause id, shown on curated options. */
  scores?: ReadonlyMap<string, number>;
  focus?: Pick<TokenFocus, "categories"> | null;
}

/** "Org name" or a shortened id while the name loads. */
export function optionName(id: string, inputs: Pick<BallotOptionInputs, "orgs" | "causes">): string {
  const key = id.toLowerCase();
  return inputs.orgs?.get(key)?.name ?? inputs.causes?.get(key)?.name ?? (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
}

/** The options as `BallotOptionData` (id = ballot index). Options with an unknown source are listed under Rotation. */
export function toBallotOptions(inputs: BallotOptionInputs): BallotOptionData[] {
  return inputs.options.map((id, i) => {
    const key = id.toLowerCase();
    const org = inputs.orgs?.get(key);
    const source: BallotSource = inputs.sources[i] ?? "rotation";
    const score = inputs.scores?.get(key);
    return {
      id: String(i),
      org: optionName(id, inputs),
      category: orgCause(org, inputs.focus),
      region: orgRegionLabel(org),
      source,
      ...(source === "curated" && score !== undefined ? { score: `${score}/100` } : {}),
    };
  });
}

// ---- epoch clock and status

export interface EpochClock {
  epoch: bigint;
  /** Unix seconds. */
  start: number;
  /** Unix seconds, exclusive. */
  end: number;
}

/** The current epoch and its window, from the governor (`currentEpoch`, `epochStart`). */
export async function loadEpochClock(cfg: Pick<AppConfig, "governorAddress">, deps: Pick<DataDeps, "chain">): Promise<EpochClock> {
  if (!cfg.governorAddress) throw new Error("Governor address not configured");
  const client = deps.chain();
  const g = { address: cfg.governorAddress, abi: epochGovernorAbi } as const;
  const epoch = await client.readContract({ ...g, functionName: "currentEpoch" });
  const start = await client.readContract({ ...g, functionName: "epochStart", args: [epoch] });
  return { epoch, start: Number(start), end: Number(start + EPOCH_LENGTH) };
}

export type EpochPhase = "unopened" | "open" | "counting" | "tallied" | "finalized";

export interface EpochStatus {
  phase: EpochPhase;
  label: string;
  /** Badge tone in the library. */
  tone: "neutral" | "cause" | "rwa" | "ink";
}

/** Where a token's epoch is in its life, from the indexer (or chain) detail and the clock. */
export function epochStatus(detail: Pick<EpochDetail, "poll" | "prepared" | "finalized" | "end"> | null | undefined, nowSeconds: number): EpochStatus {
  if (detail?.finalized) return { phase: "finalized", label: "Finalized", tone: "ink" };
  const poll: PollSummary | null | undefined = detail?.poll;
  if (poll?.isFinal) return { phase: "tallied", label: "Tally decrypted", tone: "cause" };
  if (!detail || (!detail.prepared && !poll?.opened)) return { phase: "unopened", label: "Ballot not opened", tone: "neutral" };
  if (poll?.closed || (detail.end !== undefined && nowSeconds >= detail.end)) return { phase: "counting", label: "Counting votes", tone: "rwa" };
  return { phase: "open", label: "Open for ballots", tone: "cause" };
}

/** Whether a ballot can be cast now. */
export function canVote(status: EpochStatus, opts: { optionCount: number; hasVoted: boolean }): boolean {
  return status.phase === "open" && opts.optionCount > 1 && !opts.hasVoted;
}

// ---- per-token epoch overview

export interface TokenEpochRow<T> {
  token: T;
  detail: EpochDetail | null;
  /** The indexer could not answer for this token (as opposed to "no epoch row yet"). */
  failed: boolean;
}

/** `epochDetail` for each token with a small concurrency cap, so a long list does not stampede the indexer. */
export async function loadTokenEpochs<T extends { address: string }>(
  deps: Pick<DataDeps, "indexer">,
  tokens: readonly T[],
  epoch: bigint,
  concurrency = 6,
): Promise<TokenEpochRow<T>[]> {
  const out: TokenEpochRow<T>[] = new Array(tokens.length);
  let next = 0;
  async function worker() {
    while (next < tokens.length) {
      const i = next++;
      const token = tokens[i]!;
      try {
        out[i] = { token, detail: await deps.indexer.epochDetail(token.address, epoch), failed: false };
      } catch {
        out[i] = { token, detail: null, failed: true };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tokens.length) }, worker));
  return out;
}

// ---- the viewer's weight (account-scoped; pass a client made by createAccountClient)

export interface Standing {
  weight: bigint;
  voted: boolean;
}

/** `weightOf` and `hasVoted` for one token. The client must be an account client. */
export async function readStanding(client: Pick<PublicClient, "readContract">, governor: Address, token: Address, epoch: bigint, account: Address): Promise<Standing> {
  const g = { address: governor, abi: epochGovernorAbi } as const;
  const [weight, voted] = await Promise.all([
    client.readContract({ ...g, functionName: "weightOf", args: [token, epoch, account] }),
    client.readContract({ ...g, functionName: "hasVoted", args: [token, epoch, account] }),
  ]);
  return { weight, voted };
}

/** "1,234" or "38.9M" for a count of whole tokens. */
export function formatWeight(weight: bigint | number): string {
  const n = typeof weight === "bigint" ? Number(weight) : weight;
  return new Intl.NumberFormat("en-US", { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

// ---- results

export interface ResultRow {
  index: number;
  id: string;
  votes: bigint;
  /** Percent of all votes, one decimal; 0 when nobody voted. */
  share: number;
  leader: boolean;
}

/** Per-option totals from the decrypted tally, in ballot order, with the leading option marked (ties mark the first). */
export function tallyResults(options: readonly string[], counts: readonly string[] | null | undefined): ResultRow[] | null {
  if (!counts || counts.length === 0) return null;
  const votes = options.map((_, i) => BigInt(/^\d+$/.test(counts[i] ?? "") ? counts[i]! : "0"));
  const total = votes.reduce((a, b) => a + b, 0n);
  const top = votes.reduce((best, v, i) => (v > (votes[best] ?? -1n) ? i : best), 0);
  return options.map((id, i) => ({
    index: i,
    id,
    votes: votes[i]!,
    share: total === 0n ? 0 : Number((votes[i]! * 1000n) / total) / 10,
    leader: total > 0n && i === top,
  }));
}

// ---- history: finalized epochs and donations (public indexer feeds, no address involved)

export interface FinalizedEpoch {
  token: string;
  epoch: string;
  winningCauseId: string | null;
  voteCount: number;
  /** USDC base units. */
  donatedAmount: string;
  finalizedAt?: number;
  donatedAt?: number;
}

export interface PoolDonation {
  id: string;
  token: string;
  epoch: string;
  causeId: string;
  payout: string;
  /** USDC base units. */
  amount: string;
  timestamp?: number;
  txHash?: string;
}

const ZERO_ID = /^0x0{64}$/i;
const dec = (v: unknown): string => (typeof v === "string" && /^\d+$/.test(v) ? v : typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : "0");
const optSeconds = (v: unknown): number | undefined => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : undefined);

/** A finalized epoch from an `epoch` activity item; null for other kinds. */
export function toFinalizedEpoch(item: ActivityItem): FinalizedEpoch | null {
  if (item.kind !== "epoch" || !item.token) return null;
  const d = item.data;
  const winner = typeof d.winningCauseId === "string" && !ZERO_ID.test(d.winningCauseId) ? d.winningCauseId : null;
  return {
    token: item.token,
    epoch: dec(d.epoch),
    winningCauseId: winner,
    voteCount: Number(dec(d.voteCount)),
    donatedAmount: dec(d.donatedAmount),
    finalizedAt: item.timestamp,
    donatedAt: optSeconds(d.donatedAt),
  };
}

/** A pool payout from a `donation` activity item; null for other kinds. */
export function toPoolDonation(item: ActivityItem): PoolDonation | null {
  if (item.kind !== "donation" || !item.token || typeof item.data.causeId !== "string") return null;
  return {
    id: item.id,
    token: item.token,
    epoch: dec(item.data.epoch),
    causeId: item.data.causeId,
    payout: typeof item.data.payout === "string" ? item.data.payout : "",
    amount: dec(item.data.amount),
    timestamp: item.timestamp,
    txHash: item.txHash,
  };
}

/** USDC base units as a number of dollars (display only). */
export function usdcToUsd(amount: string | bigint): number {
  const v = typeof amount === "bigint" ? amount : /^\d+$/.test(amount) ? BigInt(amount) : 0n;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  return Number(v / unit) + Number(v % unit) / Number(unit);
}

export interface History {
  epochs: FinalizedEpoch[];
  donations: PoolDonation[];
}

/** The newest finalized epochs and pool payouts across every token (two public feeds). */
export async function loadHistory(deps: Pick<DataDeps, "indexer">, limit = 50): Promise<History> {
  const [epochs, donations] = await Promise.all([
    deps.indexer.activity({ kind: "epoch", limit }),
    deps.indexer.activity({ kind: "donation", limit }),
  ]);
  return {
    epochs: epochs.items.map(toFinalizedEpoch).filter((e): e is FinalizedEpoch => e !== null),
    donations: donations.items.map(toPoolDonation).filter((d): d is PoolDonation => d !== null),
  };
}

export interface HistoryLabels {
  /** Name of the winning org by lowercase cause id. */
  cause(causeId: string): { name: string; category: CauseName };
  /** Token symbol/name by lowercase address. */
  token(address: string): string;
}

/** The timeline's rows: each payout to a winning charity, newest first. */
export function donationTimeline(donations: readonly PoolDonation[], labels: HistoryLabels, chainId: number): Donation[] {
  return donations
    .filter((d) => d.timestamp !== undefined && BigInt(d.amount) > 0n)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .map((d) => {
      const cause = labels.cause(d.causeId.toLowerCase());
      return {
        id: d.id,
        org: cause.name,
        amount: usdcToUsd(d.amount),
        cause: cause.category,
        at: (d.timestamp ?? 0) * 1000,
        coin: labels.token(d.token.toLowerCase()),
        via: "pool" as const,
        txHref: txUrl(chainId, d.txHash),
      };
    });
}

/** Causes ranked by total paid out in the loaded window. */
export function causeLeaderboard(donations: readonly PoolDonation[], labels: HistoryLabels): LeaderboardEntry[] {
  const totals = new Map<string, bigint>();
  for (const d of donations) totals.set(d.causeId.toLowerCase(), (totals.get(d.causeId.toLowerCase()) ?? 0n) + BigInt(d.amount));
  return [...totals]
    .filter(([, v]) => v > 0n)
    .map(([id, v]) => {
      const cause = labels.cause(id);
      return { id, name: cause.name, cause: cause.category, raised: usdcToUsd(v) };
    });
}

// ---- curator picks per option

export interface PickInfo {
  score: number;
  agent: string;
}

/** Curator picks by lowercase cause id (`keccak256(orgId)`, what ballots list): the best score across agents. */
export function pickIndex(reports: readonly { agent: string; report: Pick<AgentReport, "regions"> | null }[]): Map<string, PickInfo> {
  const out = new Map<string, PickInfo>();
  for (const { agent, report } of reports) {
    for (const r of report?.regions ?? []) {
      for (const p of r.picks) {
        const key = causeIdOfOrg(p.orgId as Hex).toLowerCase();
        const have = out.get(key);
        if (!have || p.score > have.score) out.set(key, { score: p.score, agent });
      }
    }
  }
  return out;
}

// ---- token art

/** A token's logo on the Swarm read gateway, or null when there is none to show. */
export function tokenLogoUrl(gateway: string | undefined, ref: string | null | undefined): string | null {
  if (!gateway || !ref || /^0x0{64}$/i.test(ref)) return null;
  try {
    return swarmGatewayUrl(gateway, ref);
  } catch {
    return null;
  }
}
