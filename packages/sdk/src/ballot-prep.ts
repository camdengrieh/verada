/**
 * Opening a token's current epoch: the planning shared by the publisher's keeper and the web app's
 * "Open this week's ballot" button. `planBallotOpening` decides, from chain state and the indexer's
 * catalogue and pick proofs, which permissionless call opens the epoch (`openEpoch`,
 * `prepareBallot` or `prepareCuratedBallot`) and builds its arguments; `ballotCall` turns that into
 * a contract call for any viem or wagmi writer. When a curator's published picks cannot be obtained
 * the plan fails with `CuratedPicksUnavailable`: the governors take no ballot without them.
 *
 * Live tokens' rotation rounds are prepared by the same planner (`planRoundOpening`, `roundCall`),
 * since both governors build ballots with `CatalogBallotLib`.
 */
import { zeroAddress, type Abi, type Address, type Hex } from "viem";
import { causeCatalogAbi, causeRegistryAbi, curatorRegistryAbi, epochGovernorAbi, rotationGovernorAbi, tokenProfileRegistryAbi } from "./abis/index.js";
import { AGENT_CATEGORIES, curatedQuotas, planBallot, type CurationSlot } from "./agents.js";
import { bucketParts, DRAW_FACTOR, drawIndex, focusBuckets, locate, REGIONS } from "./catalog.js";

/** Chain reads ballot preparation needs (`EpochGovernor`, `CauseCatalog`, `CauseRegistry`, focus). */
export interface BallotReader {
  isPrepared(token: Address, epoch: bigint): Promise<boolean>;
  /** `EpochGovernor.poolOf`: catalogue version in effect at the epoch's start and the pool size. */
  poolOf(token: Address, epoch: bigint): Promise<{ version: number; poolSize: bigint }>;
  /** Cause ids pinned for the epoch (`shortlistFor`). */
  pinned(token: Address, epoch: bigint): Promise<readonly Hex[]>;
  /**
   * `EpochGovernor.ballotSizeFor(token, epoch)`: the epoch's ballot size, the token's own choice
   * bounded by the protocol cap and the scheme (the cap alone when it made none).
   */
  ballotSize(token: Address, epoch: bigint): Promise<number>;
  focusOf(token: Address): Promise<{ categoryMask: bigint; regionMask: number }>;
  bucketSizes(version: number): Promise<readonly number[]>;
  catalogRoot(version: number): Promise<Hex>;
  isBlocked(causeId: Hex): Promise<boolean>;
  /**
   * `CuratorRegistry.curationsFor` through the governor's registry, for the given focus buckets
   * (ascending). Omitted, or answering [], when the governor has no curator registry.
   */
  curationsFor?(epoch: bigint, version: number, buckets: number[]): Promise<{ bucket: number; picksRoot: Hex; count: number; weight: number }[]>;
}

export interface PickWithProof {
  rank: number;
  catalogIndex: number;
  orgId: Hex;
  proof: Hex[];
}

/** An agent's picks with proofs for one bucket and epoch (indexer `/api/agents/:label/picks/...`). */
export interface PickSource {
  picks(label: string, epoch: bigint, region: string): Promise<{ picksRoot: Hex; items: PickWithProof[] } | null>;
}

export interface EntryWithProof {
  bucket: number;
  index: number;
  orgId: Hex;
  proof: Hex[];
}

/** Catalogue entries with proofs, from the indexer's `/api/catalog/entries`. */
export interface CatalogEntrySource {
  /**
   * `catalog` is the version the ballot is built from and its root on chain. It is not always the
   * latest version: a rotation round keeps the version in effect at the start of the weekly epoch
   * containing its vote start (`CatalogBallotBuilder.versionOf`), all week, so a source serving
   * several catalogue snapshots answers from the one with this root (indexer `?root=`).
   */
  entries(at: { bucket: number; index: number }[], catalog?: { version: number; root: Hex }): Promise<{ root: Hex; items: EntryWithProof[] }>;
}

/**
 * A usable curation whose picks cannot be obtained. Both governors require a draw for every curated
 * slot for as long as the curation is usable, so the ballot waits: retry until the agent serves the
 * picks, or the curator registry owner voids that epoch's curation (`CuratorRegistry.voidCurations`)
 * and rotation fills the ballot.
 */
export class CuratedPicksUnavailable extends Error {
  /** Optional retry hint (epoch ms). The planners leave it unset: the picks may turn up any time. */
  retryAt?: number;
  constructor(message: string) {
    super(`${message}; ${PICKS_REMEDY}`);
    this.name = "CuratedPicksUnavailable";
  }
}

/** What unblocks a ballot waiting for curator picks, appended to every `CuratedPicksUnavailable`. */
export const PICKS_REMEDY =
  "waiting for the agent to serve them or the registry owner to void the curation (CuratorRegistry.voidCurations)";

export class CatalogMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMismatch";
  }
}

export type CuratedDrawArg = { catalogIndex: number; pickOrgId: Hex; pickProof: Hex[]; entryOrgId: Hex; entryProof: Hex[] };
export type DrawArg = { orgId: Hex; proof: Hex[] };

/** The permissionless call that opens a token's current epoch. */
export type BallotAction =
  | { kind: "openEpoch"; token: Address; epoch: bigint }
  | { kind: "prepareBallot"; token: Address; epoch: bigint; draws: DrawArg[] }
  | { kind: "prepareCuratedBallot"; token: Address; epoch: bigint; curated: CuratedDrawArg[]; draws: DrawArg[] };

export type BallotStep = { type: "none"; reason: string; terminal: boolean } | { type: "send"; action: BallotAction };

/** `{ address, abi, functionName, args }` of a ballot action on the epoch governor. */
export function ballotCall(action: BallotAction, epochGovernor: Address): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  const base = { address: epochGovernor, abi: epochGovernorAbi as Abi };
  switch (action.kind) {
    case "openEpoch":
      return { ...base, functionName: "openEpoch", args: [action.token, action.epoch] };
    case "prepareBallot":
      return { ...base, functionName: "prepareBallot", args: [action.token, action.epoch, action.draws] };
    case "prepareCuratedBallot":
      return { ...base, functionName: "prepareCuratedBallot", args: [action.token, action.epoch, action.curated, action.draws] };
  }
}

export interface BallotPreparerDeps {
  reader: BallotReader;
  entries: CatalogEntrySource;
  picks?: PickSource;
}

const BATCH = 100;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const none = (reason: string, terminal = false): BallotStep => ({ type: "none", reason, terminal });

/**
 * Plans the opening of the current epoch of a token. Ballots are rejected until the epoch is
 * opened, and anyone may open it: `openEpoch` when the ballot needs no draws (its pins fill it, or
 * it has no catalogue pool), `prepareCuratedBallot` when curator agents' picks fill some of it,
 * `prepareBallot` with rotation draws otherwise. The plan is computed locally (`planBallot`,
 * mirroring the governor); the indexer supplies catalogue entries, pick leaves and their proofs,
 * and both must match the roots on chain, so a wrong indexer can only make the plan fail. When a
 * usable curation's picks cannot be obtained it throws {@link CuratedPicksUnavailable}.
 */
export async function planBallotOpening(deps: BallotPreparerDeps, token: Address, epoch: bigint): Promise<BallotStep> {
  const r = deps.reader;
  if (await r.isPrepared(token, epoch)) return none("ballot prepared", true);
  const plan = await planCatalogBallot(deps, token, epoch, epoch);
  switch (plan.kind) {
    case "open":
      return { type: "send", action: { kind: "openEpoch", token, epoch } };
    case "rotation":
      return { type: "send", action: { kind: "prepareBallot", token, epoch, draws: plan.draws } };
    case "curated":
      return { type: "send", action: { kind: "prepareCuratedBallot", token, epoch, curated: plan.curated, draws: plan.draws } };
  }
}

/**
 * Chain reads every catalogue ballot needs, weekly or rotation: `round` is the epoch or the target
 * rotation, since both governors expose these views with the same signatures. The one exception is
 * `ballotSize`: the weekly reader reads the token's `ballotSizeFor(token, epoch)`, while
 * `RotationGovernor` has one size for every round (`ballotSize()`), so its reader ignores both.
 */
export type CatalogBallotReader = Pick<
  BallotReader,
  "poolOf" | "pinned" | "ballotSize" | "focusOf" | "bucketSizes" | "catalogRoot" | "isBlocked" | "curationsFor"
>;

/** The ballot {@link planCatalogBallot} built. */
type CatalogPlan =
  | { kind: "open" }
  | { kind: "rotation"; draws: DrawArg[] }
  | { kind: "curated"; curated: CuratedDrawArg[]; draws: DrawArg[] };

/**
 * `CatalogBallotLib` planned locally (`planBallot`): pins, then the curated phase over the
 * curations of weekly epoch `curationEpoch` (null: no curated phase), then rotation draws seeded by
 * `round` (`drawIndex(token, round, version, k, pool)`, the same seed in both governors). When a
 * usable curation's picks cannot be obtained it throws {@link CuratedPicksUnavailable}: both
 * governors require them, so there is no rotation-only ballot to fall back to. The indexer supplies
 * catalogue entries, pick leaves and their proofs, and both must match the roots on chain.
 */
async function planCatalogBallot(
  deps: { reader: CatalogBallotReader; entries: CatalogEntrySource; picks?: PickSource },
  token: Address,
  round: bigint,
  curationEpoch: bigint | null,
): Promise<CatalogPlan> {
  const r = deps.reader;
  const [{ version, poolSize }, pinnedAll, size, focus] = await Promise.all([
    r.poolOf(token, round),
    r.pinned(token, round),
    r.ballotSize(token, round),
    r.focusOf(token),
  ]);
  if (version === 0 || poolSize === 0n) return { kind: "open" };
  const pinned: Hex[] = [];
  for (const c of pinnedAll) if (!(await r.isBlocked(c))) pinned.push(c);
  if (pinned.length >= size) return { kind: "open" };

  const [bucketSizes, root] = await Promise.all([r.bucketSizes(version), r.catalogRoot(version)]);
  const fb = focusBuckets(bucketSizes, focus.categoryMask, focus.regionMask);
  const total = fb.reduce((n, b) => n + b.size, 0);
  if (BigInt(total) !== poolSize) throw new CatalogMismatch(`pool size ${total} does not match the governor's ${poolSize}`);
  const slots = size - pinned.length;

  // Curated phase: the agents' picks for the focus buckets, with proofs, from the indexer.
  const onChain =
    curationEpoch !== null && r.curationsFor && fb.length > 0 ? await r.curationsFor(curationEpoch, version, fb.map((b) => b.bucket)) : [];
  const curations: (CurationSlot & { picksRoot: Hex })[] = onChain.filter((c) => c.count > 0 && c.weight > 0).sort((a, b) => a.bucket - b.bucket);
  const quotas = curatedQuotas(slots, curations);
  const picks = new Map<string, PickWithProof>();
  for (let i = 0; i < curations.length; i++) {
    const c = curations[i]!;
    if (quotas[i] === 0) continue;
    const { categoryBit, regionBit } = bucketParts(c.bucket);
    const label = AGENT_CATEGORIES.find((a) => a.bit === categoryBit)?.ensLabel;
    const region = REGIONS.find((x) => x.bit === regionBit)?.slug;
    if (!deps.picks || !label || !region) throw new CuratedPicksUnavailable(`no pick source for bucket ${c.bucket} (epoch ${curationEpoch})`);
    const got = await deps.picks.picks(label, curationEpoch!, region);
    if (!got || got.picksRoot.toLowerCase() !== c.picksRoot.toLowerCase()) {
      throw new CuratedPicksUnavailable(`${label}/${region} picks for epoch ${curationEpoch} are not published with root ${c.picksRoot}`);
    }
    for (const p of got.items) picks.set(`${c.bucket}:${p.rank}`, p);
    for (let rank = 0; rank < quotas[i]!; rank++) {
      if (!picks.has(`${c.bucket}:${rank}`)) throw new CuratedPicksUnavailable(`${label}/${region} has no pick at rank ${rank} for epoch ${curationEpoch}`);
    }
  }

  // Every entry the ballot could consume, fetched up front in batches: the curated picks'
  // entries and the rotation's draws for the most slots rotation could fill. Anything else
  // (rotation with fewer slots switches to sequential order on small pools) is fetched lazily.
  const sequential = total <= slots;
  const budget = sequential ? total : DRAW_FACTOR * slots;
  const wanted = new Map<string, { bucket: number; index: number }>();
  curations.forEach((c, i) => {
    for (let rank = 0; rank < quotas[i]!; rank++) {
      const p = picks.get(`${c.bucket}:${rank}`)!;
      if (p.catalogIndex < (bucketSizes[c.bucket] ?? 0)) wanted.set(`${c.bucket}:${p.catalogIndex}`, { bucket: c.bucket, index: p.catalogIndex });
    }
  });
  for (let k = 0; k < budget; k++) {
    const idx = sequential ? k : drawIndex(token, round, version, k, total);
    const at = locate(bucketSizes, focus.categoryMask, focus.regionMask, idx);
    wanted.set(`${at.bucket}:${at.index}`, at);
  }
  const got = new Map<string, EntryWithProof>();
  const fetchEntries = async (list: { bucket: number; index: number }[]) => {
    for (let i = 0; i < list.length; i += BATCH) {
      const res = await deps.entries.entries(list.slice(i, i + BATCH), { version, root });
      if (res.root.toLowerCase() !== root.toLowerCase()) {
        throw new CatalogMismatch(`indexer catalogue root ${res.root} is not version ${version}'s ${root}`);
      }
      for (const e of res.items) got.set(`${e.bucket}:${e.index}`, e);
    }
  };
  await fetchEntries([...wanted.values()]);
  const entry = async (bucket: number, index: number) => {
    const key = `${bucket}:${index}`;
    if (!got.has(key)) await fetchEntries([{ bucket, index }]);
    const e = got.get(key);
    if (!e) throw new CatalogMismatch(`indexer has no catalogue entry ${key}`);
    return e;
  };

  const blocked = new Map<string, boolean>();
  const plan = await planBallot(
    { token, epoch: round, version, bucketSizes, categoryMask: focus.categoryMask, regionMask: focus.regionMask, pinned, ballotSize: size, curations },
    {
      entryAt: async (bucket, index) => (await entry(bucket, index)).orgId,
      async pickAt(bucket, rank) {
        const p = picks.get(`${bucket}:${rank}`);
        if (!p) throw new CuratedPicksUnavailable(`no pick at ${bucket}:${rank}`);
        return { catalogIndex: p.catalogIndex, orgId: p.orgId };
      },
      async isBlocked(causeId) {
        const k = causeId.toLowerCase();
        if (!blocked.has(k)) blocked.set(k, await r.isBlocked(causeId));
        return blocked.get(k)!;
      },
    },
  );
  const draws = plan.draws.map((d) => ({ orgId: d.orgId, proof: got.get(`${d.bucket}:${d.index}`)!.proof }));
  if (plan.curated.length === 0) return { kind: "rotation", draws };
  const curated = plan.curated.map((c) => {
    const pick = picks.get(`${c.bucket}:${c.rank}`)!;
    const e = c.entryOrgId ? got.get(`${c.bucket}:${c.catalogIndex}`)! : null;
    return {
      catalogIndex: c.catalogIndex,
      pickOrgId: c.pickOrgId,
      pickProof: pick.proof,
      // Past the bucket's end the governor skips the pick without reading the entry.
      entryOrgId: e ? e.orgId : ZERO32,
      entryProof: e ? e.proof : [],
    };
  });
  return { kind: "curated", curated, draws };
}

/** {@link planBallotOpening} bound to its sources. */
export function createBallotPreparer(deps: BallotPreparerDeps) {
  return { plan: (token: Address, epoch: bigint) => planBallotOpening(deps, token, epoch) };
}

export type BallotPreparer = ReturnType<typeof createBallotPreparer>;

/**
 * The part of a viem `PublicClient` the ballot reader uses. Typed loosely so clients from any viem
 * copy in the workspace fit.
 */
export interface BallotReadClient {
  readContract(args: never): Promise<unknown>;
  getBlock(args: never): Promise<unknown>;
}

/**
 * viem-backed {@link BallotReader}. Catalogue, registry, profile registry and curator registry
 * addresses come from the governor's immutables (or its one-time setter) and are read once.
 */
export function createBallotReader(client: BallotReadClient, epochGovernor: Address): BallotReader {
  const eg = epochGovernor;
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  let linked: Promise<{ catalog: Address; registry: Address; profiles: Address }> | undefined;
  const links = () =>
    (linked ??= Promise.all([
      read<Address>(eg, epochGovernorAbi, "catalog"),
      read<Address>(eg, epochGovernorAbi, "registry"),
      read<Address>(eg, epochGovernorAbi, "profileRegistry"),
    ]).then(([catalog, registry, profiles]) => ({ catalog, registry, profiles })));
  let curatorsOf: Promise<Address> | undefined;
  return {
    isPrepared: (token, epoch) => read<boolean>(eg, epochGovernorAbi, "isPrepared", [token, epoch]),
    async poolOf(token, epoch) {
      const [version, poolSize] = await read<readonly [number, bigint]>(eg, epochGovernorAbi, "poolOf", [token, epoch]);
      return { version: Number(version), poolSize };
    },
    pinned: (token, epoch) => read<readonly Hex[]>(eg, epochGovernorAbi, "shortlistFor", [token, epoch]),
    ballotSize: async (token, epoch) => Number(await read<bigint>(eg, epochGovernorAbi, "ballotSizeFor", [token, epoch])),
    async focusOf(token) {
      const { profiles } = await links();
      const [categoryMask, regionMask] = await read<readonly [bigint, number]>(profiles, tokenProfileRegistryAbi, "focusOf", [token]);
      return { categoryMask, regionMask: Number(regionMask) };
    },
    async bucketSizes(version) {
      const { catalog } = await links();
      return (await read<readonly number[]>(catalog, causeCatalogAbi, "bucketSizesOf", [version])).map(Number);
    },
    async catalogRoot(version) {
      const { catalog } = await links();
      return read<Hex>(catalog, causeCatalogAbi, "rootOf", [version]);
    },
    async isBlocked(causeId) {
      const { registry } = await links();
      return read<boolean>(registry, causeRegistryAbi, "isBlocked", [causeId]);
    },
    async curationsFor(epoch, version, buckets) {
      const curators = await (curatorsOf ??= read<Address>(eg, epochGovernorAbi, "curators"));
      if (curators === zeroAddress) return [];
      const cs = await read<readonly { picksRoot: Hex; count: number; weight: number }[]>(curators, curatorRegistryAbi, "curationsFor", [epoch, version, buckets]);
      return cs.map((c, i) => ({ bucket: buckets[i]!, picksRoot: c.picksRoot, count: Number(c.count), weight: Number(c.weight) }));
    },
  };
}

// ---------------------------------------------------------------- live mode: rotation rounds

/** `IRotationGovernor.RoundStatus`, in enum order. */
export const ROUND_STATUSES = ["None", "Open", "Closed", "NoChange", "Applied", "Stale", "InactiveWinner", "NoBallot"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** `PollScopeLib.KIND_ROTATION`: scope kind of a rotation poll (the id is the target rotation). */
export const POLL_KIND_ROTATION = 1n;

/** Voting-scheme scope of the rotation poll for `target` (`PollScopeLib.encode(KIND_ROTATION, target)`). */
export function rotationPollScope(target: bigint): bigint {
  if (target < 0n || target >= 1n << 64n) throw new RangeError("target out of range");
  return (POLL_KIND_ROTATION << 248n) | target;
}

/** `PollScopeLib.KIND_PERIOD`: scope kind of a period-change proposal (the id is the proposal id). */
export const POLL_KIND_PERIOD = 2n;

/** Voting-scheme scope of period-change proposal `id` (`PollScopeLib.encode(KIND_PERIOD, id)`). */
export function periodPollScope(id: bigint): bigint {
  if (id < 0n || id >= 1n << 64n) throw new RangeError("id out of range");
  return (POLL_KIND_PERIOD << 248n) | id;
}

/** `IRotationGovernor.ProposalState` (period-change proposals), in enum order. */
export const PERIOD_PROPOSAL_STATES = ["None", "Active", "Ended", "Closed", "Defeated", "Executed", "Expired", "Canceled"] as const;
export type PeriodProposalState = (typeof PERIOD_PROPOSAL_STATES)[number];

/** Chain reads round preparation needs (`RotationGovernor` and its linked contracts). */
export interface RoundReader extends CatalogBallotReader {
  /** `roundOf(token, target).status`. */
  roundStatus(token: Address, target: bigint): Promise<RoundStatus>;
  currentRotation(token: Address): Promise<bigint>;
  /** `pollWindow(token, target)`, in seconds (zeros without a schedule for `target`). */
  pollWindow(token: Address, target: bigint): Promise<{ snapshot: bigint; voteStart: bigint; voteEnd: bigint }>;
  /** `curationEpochOf(token, target)`: the weekly epoch whose curations feed the round. */
  curationEpochOf(token: Address, target: bigint): Promise<{ ok: boolean; epoch: bigint }>;
  /** Latest block timestamp, in seconds. */
  now(): Promise<bigint>;
}

/** The permissionless call that prepares (and opens) a token's next rotation round. */
export type RoundAction =
  /** `openRound(token)`: no draws (pins fill the ballot, or there is no catalogue pool). */
  | { kind: "openRound"; token: Address; target: bigint }
  | { kind: "prepareRound"; token: Address; target: bigint; draws: DrawArg[] }
  | { kind: "prepareCuratedRound"; token: Address; target: bigint; curated: CuratedDrawArg[]; draws: DrawArg[] };

export type RoundStep = { type: "none"; reason: string; terminal: boolean } | { type: "send"; action: RoundAction };

/** `{ address, abi, functionName, args }` of a round action on the rotation governor. */
export function roundCall(action: RoundAction, rotationGovernor: Address): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } {
  const base = { address: rotationGovernor, abi: rotationGovernorAbi as Abi };
  switch (action.kind) {
    case "openRound":
      return { ...base, functionName: "openRound", args: [action.token] };
    case "prepareRound":
      return { ...base, functionName: "prepareRound", args: [action.token, action.target, action.draws] };
    case "prepareCuratedRound":
      return { ...base, functionName: "prepareCuratedRound", args: [action.token, action.target, action.curated, action.draws] };
  }
}

export interface RoundPreparerDeps {
  reader: RoundReader;
  entries: CatalogEntrySource;
  picks?: PickSource;
}

const noneRound = (reason: string, terminal = false): RoundStep => ({ type: "none", reason, terminal });

/**
 * Plans the preparation of round `target` of a live token, the poll on the cause of rotation
 * `target`, which only the next rotation's round (`target = currentRotation + 1`) can get, during
 * its vote window. The ballot is planned exactly like a weekly one ({@link planBallotOpening}, the
 * same `CatalogBallotLib`): pins, then the curated picks of the weekly epoch containing the vote
 * start (`curationEpochOf`), then rotation draws seeded by `target`. When a usable curation's picks
 * cannot be obtained, the plan fails with {@link CuratedPicksUnavailable} for the whole vote window:
 * the builder requires the curated draws for as long as the curation is usable.
 */
export async function planRoundOpening(deps: RoundPreparerDeps, token: Address, target: bigint): Promise<RoundStep> {
  const r = deps.reader;
  const status = await r.roundStatus(token, target);
  if (status !== "None") return noneRound("round prepared", true);
  const [current, window, now] = await Promise.all([r.currentRotation(token), r.pollWindow(token, target), r.now()]);
  if (target <= current) return noneRound("round can no longer be prepared", true);
  if (target !== current + 1n) return noneRound("round is not the next rotation's");
  if (window.voteEnd === 0n) return noneRound("round has no vote window", true);
  // The rotation moves on at `start(target)`; the round is then out of reach for good.
  if (now >= window.voteEnd) return noneRound("round's vote window ended");
  const curation = await r.curationEpochOf(token, target);
  const plan = await planCatalogBallot(deps, token, target, curation.ok ? curation.epoch : null);
  switch (plan.kind) {
    case "open":
      return { type: "send", action: { kind: "openRound", token, target } };
    case "rotation":
      return { type: "send", action: { kind: "prepareRound", token, target, draws: plan.draws } };
    case "curated":
      return { type: "send", action: { kind: "prepareCuratedRound", token, target, curated: plan.curated, draws: plan.draws } };
  }
}

/** {@link planRoundOpening} bound to its sources. */
export function createRoundPreparer(deps: RoundPreparerDeps) {
  return { plan: (token: Address, target: bigint) => planRoundOpening(deps, token, target) };
}

export type RoundPreparer = ReturnType<typeof createRoundPreparer>;

/**
 * viem-backed {@link RoundReader}. Catalogue, cause registry and profile registry addresses come
 * from the governor's immutables and are read once; the curator registry (set once by the owner)
 * is cached once it is set.
 */
export function createRoundReader(client: BallotReadClient, rotationGovernor: Address): RoundReader {
  const rg = rotationGovernor;
  const abi = rotationGovernorAbi as Abi;
  const read = <T>(address: Address, abi_: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: abi_, functionName, args } as never) as Promise<T>;
  let linked: Promise<{ catalog: Address; registry: Address; profiles: Address }> | undefined;
  const links = () =>
    (linked ??= Promise.all([
      read<Address>(rg, abi, "catalog"),
      read<Address>(rg, abi, "causeRegistry"),
      read<Address>(rg, abi, "profileRegistry"),
    ]).then(([catalog, registry, profiles]) => ({ catalog, registry, profiles }))).catch((err: unknown) => {
      linked = undefined;
      throw err;
    });
  let curatorsOf: Address | undefined;
  return {
    async roundStatus(token, target) {
      const [status] = await read<readonly [number, ...unknown[]]>(rg, abi, "roundOf", [token, target]);
      const s = ROUND_STATUSES[Number(status)];
      if (!s) throw new Error(`unknown round status ${status}`);
      return s;
    },
    currentRotation: (token) => read<bigint>(rg, abi, "currentRotation", [token]),
    async pollWindow(token, target) {
      const [snapshot, voteStart, voteEnd] = await read<readonly [number | bigint, number | bigint, number | bigint]>(rg, abi, "pollWindow", [token, target]);
      return { snapshot: BigInt(snapshot), voteStart: BigInt(voteStart), voteEnd: BigInt(voteEnd) };
    },
    async curationEpochOf(token, target) {
      const [ok, epoch] = await read<readonly [boolean, bigint]>(rg, abi, "curationEpochOf", [token, target]);
      return { ok, epoch };
    },
    async poolOf(token, target) {
      const [version, poolSize] = await read<readonly [number, bigint]>(rg, abi, "poolOf", [token, target]);
      return { version: Number(version), poolSize };
    },
    pinned: (token, target) => read<readonly Hex[]>(rg, abi, "shortlistFor", [token, target]),
    // One size for every token and round (RotationGovernor has no per-token choice).
    ballotSize: async () => Number(await read<bigint>(rg, abi, "ballotSize")),
    async focusOf(token) {
      const { profiles } = await links();
      const [categoryMask, regionMask] = await read<readonly [bigint, number]>(profiles, tokenProfileRegistryAbi, "focusOf", [token]);
      return { categoryMask, regionMask: Number(regionMask) };
    },
    async bucketSizes(version) {
      const { catalog } = await links();
      return (await read<readonly number[]>(catalog, causeCatalogAbi, "bucketSizesOf", [version])).map(Number);
    },
    async catalogRoot(version) {
      const { catalog } = await links();
      return read<Hex>(catalog, causeCatalogAbi, "rootOf", [version]);
    },
    async isBlocked(causeId) {
      const { registry } = await links();
      return read<boolean>(registry, causeRegistryAbi, "isBlocked", [causeId]);
    },
    now: async () => ((await client.getBlock({ blockTag: "latest" } as never)) as { timestamp: bigint }).timestamp,
    async curationsFor(epoch, version, buckets) {
      if (!curatorsOf) {
        const c = await read<Address>(rg, abi, "curators");
        if (c === zeroAddress) return [];
        curatorsOf = c;
      }
      const cs = await read<readonly { picksRoot: Hex; count: number; weight: number }[]>(curatorsOf, curatorRegistryAbi, "curationsFor", [epoch, version, buckets]);
      return cs.map((c, i) => ({ bucket: buckets[i]!, picksRoot: c.picksRoot, count: Number(c.count), weight: Number(c.weight) }));
    },
  };
}
