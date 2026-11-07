import { entryProof, loadCatalog, type BuiltCatalog, type CatalogOrg } from "@varada/cause-catalog";
import {
  CATEGORIES,
  REGIONS,
  bucketParts,
  focusBuckets,
  type CatalogEntry,
} from "@varada/sdk";
import type { Hex } from "viem";

/** The public shape of a catalogue org: no descriptions, no image URLs. */
export interface CatalogOrgResult {
  orgId: Hex;
  causeId: Hex;
  ein: string | null;
  name: string;
  country: string | null;
  state: string | null;
  nteeCode: string | null;
  claimed: boolean;
  categories: string[];
  regions: string[];
  /** ENS label (`<label>.org.<parent>`), when the catalogue build assigned one. */
  label?: string;
  /**
   * The org id Endaoment's factory uses on Ethereum, when the build resolved it. Usually `orgId`;
   * different when the live entity was created under another id. Absent on older builds.
   */
  ethOrgId?: Hex;
}

export interface CatalogEntryWithProof extends CatalogEntry {
  proof: Hex[];
}

export interface CatalogSearch {
  q?: string;
  categoryMask?: bigint;
  regionMask?: number;
  offset: number;
  limit: number;
}

/** Read access to the published cause catalogue, loaded once into memory. */
export interface CatalogStore {
  /** Null until loaded (or when no source is configured, or loading failed). */
  catalog(): BuiltCatalog | null;
  search(q: CatalogSearch): { items: CatalogOrgResult[]; total: number } | null;
  /** Orgs by cause id (`keccak256(orgId)`); unknown ids are omitted. */
  causes(causeIds: Hex[]): CatalogOrgResult[] | null;
  /** By org id or cause id (hex), EIN (hyphen optional) or Endaoment id. */
  org(id: string): { org: CatalogOrgResult; entries: CatalogEntryWithProof[] } | null | undefined;
  /** Entries by `(bucket, index)`, with proofs; unknown entries are omitted. */
  entries(at: { bucket: number; index: number }[]): CatalogEntryWithProof[] | null;
  /**
   * Entries of the loaded snapshot whose root is `root`: the main one or an extra (older) one.
   * Null while nothing is loaded; undefined when no loaded snapshot has that root.
   */
  entriesOf(root: Hex, at: { bucket: number; index: number }[]): CatalogEntryWithProof[] | null | undefined;
  pool(categoryMask: bigint, regionMask: number): { poolSize: number; buckets: { bucket: number; category: string; region: string; size: number }[] } | null;
}

/** Fields newer catalogue builds add (names and per-chain org ids); read loosely so older builds load. */
interface NamedOrg {
  label?: unknown;
  chains?: { chainId?: unknown; orgId?: unknown; source?: unknown }[];
}
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
function nameFields(o: CatalogOrg): Pick<CatalogOrgResult, "label" | "ethOrgId"> {
  const n = o as unknown as NamedOrg;
  const eth = Array.isArray(n.chains) ? n.chains.find((ch) => ch?.chainId === 1 && ch.source !== "unresolved") : undefined;
  const ethOrgId = typeof eth?.orgId === "string" && HEX32_RE.test(eth.orgId) && !/^0x0+$/.test(eth.orgId) ? (eth.orgId as Hex) : undefined;
  return {
    ...(typeof n.label === "string" && LABEL_RE.test(n.label) ? { label: n.label } : {}),
    ...(ethOrgId ? { ethOrgId } : {}),
  };
}

const toResult = (o: CatalogOrg): CatalogOrgResult => ({
  ...nameFields(o),
  orgId: o.orgId,
  causeId: o.causeId,
  ein: o.ein,
  name: o.name,
  country: o.country,
  state: o.state,
  nteeCode: o.nteeCode,
  claimed: o.claimed,
  categories: o.categories,
  regions: o.regions,
});

const slugOfCategory = (bit: number) => CATEGORIES.find((c) => c.bit === bit)?.slug ?? `category-${bit}`;
const slugOfRegion = (bit: number) => REGIONS.find((r) => r.bit === bit)?.slug ?? `region-${bit}`;

/** Builds the in-memory indexes over a loaded catalogue. Exported for tests. */
export function catalogStoreOf(c: BuiltCatalog | null): CatalogStore {
  if (!c) {
    return { catalog: () => null, search: () => null, causes: () => null, org: () => null, entries: () => null, entriesOf: () => null, pool: () => null };
  }
  // Searchable text: the name, the ENS label and the EIN (digits only, so "52-0907625" matches too).
  const names = c.orgs.map((o) => {
    const label = nameFields(o).label;
    return `${o.name.toLowerCase()}${label ? `\n${label}` : ""}${o.ein ? `\n${o.ein.replace(/-/g, "")}` : ""}`;
  });
  const masks = c.orgs.map((o) => ({ c: BigInt(o.categoryMask), r: o.regionMask }));
  const byKey = new Map<string, number>();
  c.orgs.forEach((o, i) => {
    byKey.set(o.orgId.toLowerCase(), i);
    byKey.set(o.causeId.toLowerCase(), i);
    byKey.set(o.id.toLowerCase(), i);
    if (o.ein) byKey.set(o.ein.replace(/-/g, ""), i);
  });
  const orgAt = new Map<string, Hex>();
  for (const [, [bucket, index, orgId]] of c.tree.entries()) orgAt.set(`${bucket}:${index}`, orgId);
  const withProof = (e: CatalogEntry): CatalogEntryWithProof => ({ ...e, proof: entryProof(c.tree, e) });
  const entries = (at: { bucket: number; index: number }[]) => {
    const out: CatalogEntryWithProof[] = [];
    for (const { bucket, index } of at) {
      const orgId = orgAt.get(`${bucket}:${index}`);
      if (orgId) out.push(withProof({ bucket, index, orgId }));
    }
    return out;
  };

  return {
    catalog: () => c,
    search(q) {
      const raw = q.q?.trim().toLowerCase();
      // An EIN typed with its hyphen, or a full ENS name, searches as the stored form.
      const needle = raw && /^\d{2}-\d{7}$/.test(raw) ? raw.replace("-", "") : raw?.replace(/\.org\.[a-z0-9.-]+$/, "");
      const out: CatalogOrgResult[] = [];
      let total = 0;
      for (let i = 0; i < c.orgs.length; i++) {
        if (q.categoryMask !== undefined && (masks[i]!.c & q.categoryMask) === 0n) continue;
        if (q.regionMask !== undefined && (masks[i]!.r & q.regionMask) === 0) continue;
        if (needle && !names[i]!.includes(needle)) continue;
        if (total >= q.offset && out.length < q.limit) out.push(toResult(c.orgs[i]!));
        total++;
      }
      return { items: out, total };
    },
    causes(causeIds) {
      const out: CatalogOrgResult[] = [];
      for (const id of causeIds) {
        const i = byKey.get(id.toLowerCase());
        if (i !== undefined && c.orgs[i]!.causeId.toLowerCase() === id.toLowerCase()) out.push(toResult(c.orgs[i]!));
      }
      return out;
    },
    org(id) {
      const key = id.trim().toLowerCase().replace(/^(\d{2})-(\d{7})$/, "$1$2");
      const i = byKey.get(key);
      if (i === undefined) return undefined;
      const o = c.orgs[i]!;
      return { org: toResult(o), entries: o.entries.map((e) => withProof({ ...e, orgId: o.orgId })) };
    },
    entries,
    entriesOf: (root, at) => (root.toLowerCase() === c.meta.root.toLowerCase() ? entries(at) : undefined),
    pool(categoryMask, regionMask) {
      const buckets = focusBuckets(c.meta.bucketSizes, categoryMask, regionMask).map(({ bucket, size }) => {
        const { categoryBit, regionBit } = bucketParts(bucket);
        return { bucket, category: slugOfCategory(categoryBit), region: slugOfRegion(regionBit), size };
      });
      return { poolSize: buckets.reduce((n, b) => n + b.size, 0), buckets };
    },
  };
}

/**
 * Loads the catalogue from `source` in the background and swaps it in when ready. Without a
 * source every call answers null (the routes return 503). Load errors are logged by name only.
 *
 * `source` may list several snapshots, comma-separated: the first is the catalogue every route
 * serves; the others are only served by `entriesOf` (`/api/catalog/entries?root=`), for ballots
 * still built from an older version. Rotation rounds keep the version in effect at the start of
 * the weekly epoch containing their vote start until the next epoch, so after a version is
 * published mid-week the previous snapshot is listed second until that epoch ends. Each snapshot
 * is held in memory.
 */
export function createCatalogStore(
  source: string | undefined,
  opts: { fetch?: typeof fetch; log?: (msg: string) => void } = {},
): CatalogStore & { ready: Promise<void> } {
  const sources = (source ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const stores: CatalogStore[] = sources.map(() => catalogStoreOf(null));
  const ready = Promise.all(
    sources.map((src, i) =>
      loadCatalog(src, opts.fetch)
        .then((c) => {
          stores[i] = catalogStoreOf(c);
          opts.log?.(`catalogue ${i === 0 ? "loaded" : "loaded (extra)"}: ${c.orgs.length} orgs, root ${c.meta.root}`);
        })
        .catch((e: unknown) => {
          opts.log?.(`catalogue ${i === 0 ? "" : "(extra) "}load failed: ${e instanceof Error ? e.name : "unknown"}`);
        }),
    ),
  ).then(() => undefined);
  const main = () => stores[0] ?? catalogStoreOf(null);
  return {
    ready,
    catalog: () => main().catalog(),
    search: (q) => main().search(q),
    causes: (ids) => main().causes(ids),
    org: (id) => main().org(id),
    entries: (at) => main().entries(at),
    entriesOf(root, at) {
      for (const st of stores) {
        const r = st.entriesOf(root, at);
        if (r) return r;
      }
      // Still loading: the routes answer 503 rather than "unknown root".
      return main().catalog() ? undefined : null;
    },
    pool: (cm, rm) => main().pool(cm, rm),
  };
}
