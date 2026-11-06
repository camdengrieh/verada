/**
 * Contract-vs-SDK fixture for configurable ballot sizes: `contracts/test/fixtures/ballot-sizes.json`.
 *
 * Each case is planned here exactly as the keeper and the web app plan it (`planBallotOpening`, which
 * runs `planBallot`), at ballot sizes 2, 3, 8, 16, 30 and 32 with pins past the size, blocked pins,
 * curated picks at small sizes (including zero free slots, a provably wrong pick and one past its
 * bucket) and rotation by hash draws or a sequential walk. `BallotSizeFixtureCompat.t.sol` replays
 * every case on a real `EpochGovernor` (same catalogue, pins, blocks, cap and choice, curator
 * picks behind a mock registry), sends the planned call with its own Merkle proofs, and checks the
 * governor accepts exactly those draws and commits to exactly these options.
 *
 * Regenerate with `pnpm --filter @varada/sdk gen:fixture`; `ballot-fixture.test.ts` fails on drift.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import {
  BUCKET_COUNT,
  bucketId,
  causeIdOfOrg,
  effectiveBallotSize,
  planBallot,
  planBallotOpening,
  type BallotReader,
  type PickWithProof,
} from "../src/index.js";

/** Epoch the cases are prepared in (the catalogue is published before it starts). */
export const FIXTURE_EPOCH = 3n;

const HUNGER = 2;
const CHILDREN = 3;
const AFRICA = 0;
const ASIA = 1;
const HA = bucketId(HUNGER, AFRICA);
const HAS = bucketId(HUNGER, ASIA);
const CA = bucketId(CHILDREN, AFRICA);

/** Catalogue: hunger x Africa 40 orgs, hunger x Asia 20, children x Africa 12. */
const BUCKETS: readonly [number, number][] = [
  [HA, 40],
  [HAS, 20],
  [CA, 12],
];

export function orgAt(bucket: number, index: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint16" }, { type: "uint32" }], ["org", bucket, index]));
}

interface Entry {
  bucket: number;
  index: number;
  orgId: Hex;
}

const ENTRIES: Entry[] = BUCKETS.flatMap(([bucket, n]) => Array.from({ length: n }, (_, index) => ({ bucket, index, orgId: orgAt(bucket, index) })));
const SIZES = (() => {
  const s = Array.from({ length: BUCKET_COUNT }, () => 0);
  for (const [b, n] of BUCKETS) s[b] = n;
  return s;
})();
const entryIndex = (bucket: number, index: number) => ENTRIES.findIndex((e) => e.bucket === bucket && e.index === index);
const lc = (h: Hex) => h.toLowerCase() as Hex;
const causeToOrg = new Map(ENTRIES.map((e) => [lc(causeIdOfOrg(e.orgId)), e.orgId]));

/** A curator pick: claimed catalogue index and org. */
interface Pick {
  catalogIndex: number;
  orgId: Hex;
}

interface CaseInput {
  name: string;
  token: Address;
  categoryBit: number;
  regionBits: number[];
  cap: number;
  /** The token's own size (0: follow the cap). */
  choice: number;
  /** Pinned entries `[bucket, index]`, set while the size is 32. */
  pins: [number, number][];
  /** Entries blocked after the pins were set. */
  blocked: [number, number][];
  curations: { bucket: number; weight: number; picks: Pick[] }[];
}

const tok = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const range = (n: number, f: (i: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i));
/** Rank r of `bucket` picks its entry `from - r` (reverse catalogue order). */
const reversePicks = (bucket: number, from: number, n: number): Pick[] =>
  Array.from({ length: n }, (_, r) => ({ catalogIndex: from - r, orgId: orgAt(bucket, from - r) }));
const HUNGER_AF_AS = { categoryBit: HUNGER, regionBits: [AFRICA, ASIA] };

export const CASES: readonly CaseInput[] = [
  {
    name: "size 2: three pins, the first two fill it (openEpoch)",
    token: tok(0xb5_01),
    ...HUNGER_AF_AS,
    cap: 32,
    choice: 2,
    pins: range(3, (i) => [HA, i]),
    blocked: [],
    curations: [{ bucket: HA, weight: 1, picks: reversePicks(HA, 39, 5) }],
  },
  {
    name: "size 3: a blocked pin is skipped; the one free slot goes to the first equal-weight bucket",
    token: tok(0xb5_02),
    ...HUNGER_AF_AS,
    cap: 32,
    choice: 3,
    pins: [
      [HA, 0],
      [HA, 1],
      [HA, 2],
    ],
    blocked: [[HA, 1]],
    curations: [
      { bucket: HA, weight: 1, picks: reversePicks(HA, 39, 4) },
      { bucket: HAS, weight: 1, picks: reversePicks(HAS, 19, 4) },
    ],
  },
  {
    name: "size 3: pins fill it, zero free curated slots",
    token: tok(0xb5_03),
    ...HUNGER_AF_AS,
    cap: 32,
    choice: 3,
    pins: range(3, (i) => [HA, i]),
    blocked: [],
    curations: [
      { bucket: HA, weight: 1, picks: reversePicks(HA, 39, 4) },
      { bucket: HAS, weight: 1, picks: reversePicks(HAS, 19, 4) },
    ],
  },
  {
    name: "size 8 (choice 30 above cap 8): weighted quotas capped by pick counts, a wrong pick and one past its bucket, then hash draws",
    token: tok(0xb5_04),
    ...HUNGER_AF_AS,
    cap: 8,
    choice: 30,
    pins: [
      [HA, 0],
      [HA, 1],
    ],
    blocked: [],
    curations: [
      {
        bucket: HA,
        weight: 3,
        picks: [
          { catalogIndex: 39, orgId: orgAt(HA, 39) },
          // Claims entry 38 is an Asian org: provably wrong, skipped.
          { catalogIndex: 38, orgId: orgAt(HAS, 5) },
          // Past the bucket's end: skipped without an entry proof.
          { catalogIndex: 99, orgId: orgAt(HA, 99) },
        ],
      },
      { bucket: HAS, weight: 1, picks: reversePicks(HAS, 19, 2) },
    ],
  },
  {
    name: "size 16 (protocol cap 16, the token follows it): curated picks then hash draws",
    token: tok(0xb5_05),
    ...HUNGER_AF_AS,
    cap: 16,
    choice: 0,
    pins: [],
    blocked: [],
    curations: [{ bucket: HAS, weight: 1, picks: reversePicks(HAS, 19, 4) }],
  },
  {
    name: "size 30: eight pins, rotation skips blocked entries",
    token: tok(0xb5_06),
    ...HUNGER_AF_AS,
    cap: 32,
    choice: 30,
    pins: range(8, (i) => [HA, i]),
    blocked: [
      [HA, 20],
      [HA, 30],
      [HAS, 3],
      [HAS, 11],
    ],
    curations: [],
  },
  {
    name: "size 32: a pool smaller than the free slots is walked in order after the pin and picks",
    token: tok(0xb5_07),
    categoryBit: CHILDREN,
    regionBits: [AFRICA],
    cap: 32,
    choice: 0,
    pins: [[CA, 0]],
    blocked: [[CA, 7]],
    curations: [
      {
        bucket: CA,
        weight: 1,
        picks: [
          { catalogIndex: 5, orgId: orgAt(CA, 5) },
          { catalogIndex: 6, orgId: orgAt(CA, 6) },
        ],
      },
    ],
  },
  {
    name: "size 32: one pin, two curated buckets at their pick counts, hash draws for the rest",
    token: tok(0xb5_08),
    ...HUNGER_AF_AS,
    cap: 32,
    choice: 0,
    pins: [[HA, 0]],
    blocked: [],
    curations: [
      { bucket: HA, weight: 2, picks: reversePicks(HA, 39, 10) },
      { bucket: HAS, weight: 1, picks: reversePicks(HAS, 19, 10) },
    ],
  },
];

const FAKE_ROOT = `0x${"ab".repeat(32)}` as Hex;
const pickRoot = (bucket: number) => keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint16" }], ["picks", bucket]));

async function planCase(c: CaseInput) {
  const categoryMask = 1n << BigInt(c.categoryBit);
  const regionMask = c.regionBits.reduce((m, r) => m | (1 << r), 0);
  const size = effectiveBallotSize({ cap: c.cap, choice: c.choice });
  const pinOrgs = c.pins.map(([b, i]) => orgAt(b, i));
  const blocked = new Set(c.blocked.map(([b, i]) => lc(causeIdOfOrg(orgAt(b, i)))));
  const isBlocked = async (cause: Hex) => blocked.has(lc(cause));
  const pool = ENTRIES.filter((e) => Math.floor(e.bucket / 16) === c.categoryBit && c.regionBits.includes(e.bucket % 16)).length;

  const reader: BallotReader = {
    isPrepared: async () => false,
    poolOf: async () => ({ version: 1, poolSize: BigInt(pool) }),
    pinned: async () => pinOrgs.map((o) => causeIdOfOrg(o)),
    ballotSize: async () => size,
    focusOf: async () => ({ categoryMask, regionMask }),
    bucketSizes: async () => SIZES,
    catalogRoot: async () => FAKE_ROOT,
    isBlocked,
    curationsFor: async (_e, _v, buckets) =>
      c.curations.filter((x) => buckets.includes(x.bucket)).map((x) => ({ bucket: x.bucket, picksRoot: pickRoot(x.bucket), count: x.picks.length, weight: x.weight })),
    curationSkipAt: async () => 0n,
    now: async () => 0n,
  };
  const step = await planBallotOpening(
    {
      reader,
      entries: {
        entries: async (at) => ({
          root: FAKE_ROOT,
          items: at.filter((x) => x.index < (SIZES[x.bucket] ?? 0)).map((x) => ({ ...x, orgId: orgAt(x.bucket, x.index), proof: [] })),
        }),
      },
      picks: {
        async picks(_label, _epoch, region) {
          const regionBit = ["africa", "asia"].indexOf(region);
          const cur = c.curations.find((x) => x.bucket === c.categoryBit * 16 + regionBit);
          if (!cur) return null;
          const items: PickWithProof[] = cur.picks.map((p, rank) => ({ rank, ...p, proof: [] }));
          return { picksRoot: pickRoot(cur.bucket), items };
        },
      },
    },
    c.token,
    FIXTURE_EPOCH,
  );
  if (step.type !== "send") throw new Error(`${c.name}: no call planned (${step.reason})`);

  const unblockedPins: Hex[] = [];
  for (const o of pinOrgs) if (!(await isBlocked(causeIdOfOrg(o)))) unblockedPins.push(causeIdOfOrg(o));
  const plan = await planBallot(
    {
      token: c.token,
      epoch: FIXTURE_EPOCH,
      version: 1,
      bucketSizes: SIZES,
      categoryMask,
      regionMask,
      pinned: unblockedPins,
      ballotSize: size,
      curations: c.curations.map((x) => ({ bucket: x.bucket, count: x.picks.length, weight: x.weight })),
    },
    {
      entryAt: async (b, i) => orgAt(b, i),
      pickAt: async (b, r) => c.curations.find((x) => x.bucket === b)!.picks[r]!,
      isBlocked,
    },
  );

  // The opening plan sends exactly the plan's draws.
  const a = step.action;
  const sentDraws = a.kind === "prepareBallot" || a.kind === "prepareCuratedBallot" ? a.draws.map((d) => lc(d.orgId)) : [];
  const sentCurated = a.kind === "prepareCuratedBallot" ? a.curated.map((d) => `${d.catalogIndex}:${lc(d.pickOrgId)}`) : [];
  if (JSON.stringify(sentDraws) !== JSON.stringify(plan.draws.map((d) => lc(d.orgId)))) throw new Error(`${c.name}: draws differ`);
  if (JSON.stringify(sentCurated) !== JSON.stringify(plan.curated.map((d) => `${d.catalogIndex}:${lc(d.pickOrgId)}`))) {
    throw new Error(`${c.name}: curated draws differ`);
  }

  return {
    name: c.name,
    token: c.token,
    categoryMask: Number(categoryMask),
    regionMask,
    cap: c.cap,
    choice: c.choice,
    size,
    nPins: c.pins.length,
    pins: c.pins.map(([b, i]) => entryIndex(b, i)),
    nBlocked: c.blocked.length,
    blocked: c.blocked.map(([b, i]) => entryIndex(b, i)),
    nCurations: c.curations.length,
    curations: c.curations.map((x) => ({
      bucket: x.bucket,
      weight: x.weight,
      nPicks: x.picks.length,
      pickIndex: x.picks.map((p) => p.catalogIndex),
      pickOrg: x.picks.map((p) => p.orgId),
    })),
    action: a.kind,
    nCurated: plan.curated.length,
    curated: plan.curated.map((d) => ({
      bucket: d.bucket,
      rank: d.rank,
      catalogIndex: d.catalogIndex,
      pickOrgId: d.pickOrgId,
      /** Catalogue entry number of `(bucket, catalogIndex)`; -1 past the bucket. */
      entry: d.entryOrgId ? entryIndex(d.bucket, d.catalogIndex) : -1,
    })),
    nDraws: plan.draws.length,
    draws: plan.draws.map((d) => entryIndex(d.bucket, d.index)),
    nOptions: plan.options.length,
    options: plan.options.map((cause) => causeToOrg.get(lc(cause))!),
  };
}

/** The fixture, as written to `contracts/test/fixtures/ballot-sizes.json`. */
export async function ballotSizeFixture() {
  const cases = [];
  for (const c of CASES) cases.push(await planCase(c));
  return {
    note: "Generated by packages/sdk/test/ballot-fixture.ts (pnpm --filter @varada/sdk gen:fixture). Do not edit.",
    epoch: Number(FIXTURE_EPOCH),
    nEntries: ENTRIES.length,
    entries: ENTRIES,
    nCases: cases.length,
    cases,
  };
}
