import { loadCatalog, NamesIndex, type BuiltCatalog, type CatalogOrg, type OrgChain, type RankSignals } from "@varada/cause-catalog";
import type { Hex } from "viem";

/** Parent of every org name. */
export const ORG_PARENT = "org.varada.eth";

/** What the HTTP API returns for one org. */
export interface OrgView {
  label: string;
  ensName: string;
  name: string;
  orgId: Hex;
  endaomentId: string;
  ein: string | null;
  /** Ethereum address (`chains[0].address`). */
  address: Hex | null;
  /**
   * Per chain (1, 10, 8453): the orgId the resolver uses there and its CREATE2 address.
   * `source` is `default` (toOrgId), `override` (the entity's own orgId) or `unresolved` (no record).
   */
  chains: OrgChain[];
  categories: string[];
  regions: string[];
  rank: number;
  rankSignals: RankSignals | null;
  claimed: boolean;
  nteeCode: string | null;
  country: string | null;
  state: string | null;
  website: string | null;
}

export function orgView(o: CatalogOrg): OrgView {
  const label = o.label!;
  return {
    label,
    ensName: `${label}.${ORG_PARENT}`,
    name: o.name,
    orgId: o.orgId,
    endaomentId: o.id,
    ein: o.ein,
    address: o.address ?? null,
    chains: o.chains ?? [],
    categories: o.categories,
    regions: o.regions,
    rank: o.rank ?? 0,
    rankSignals: o.rankSignals ?? null,
    claimed: o.claimed,
    nteeCode: o.nteeCode,
    country: o.country,
    state: o.state,
    website: o.website ?? null,
  };
}

/** One loaded catalogue build with its names index and sorted org lists. */
export class Build {
  readonly namesRoot: Hex;
  readonly builtAt: string;
  readonly names: NamesIndex;
  readonly byLabel = new Map<string, CatalogOrg>();
  /** Rank descending, then label. */
  readonly byRank: CatalogOrg[];
  /** Name ascending (case-insensitive), then label. */
  readonly byName: CatalogOrg[];
  /** Lowercased names, parallel to `byRank`, for search. */
  private readonly searchText = new Map<CatalogOrg, string>();

  constructor(readonly catalog: BuiltCatalog, readonly source: string) {
    if (!catalog.names || !catalog.meta.namesRoot) throw new Error(`${source}: catalogue has no names tree; rebuild it`);
    this.names = new NamesIndex(catalog.names.shards);
    this.namesRoot = this.names.root;
    this.builtAt = catalog.meta.builtAt;
    const orgs = catalog.orgs.filter((o) => o.label);
    for (const o of orgs) {
      this.byLabel.set(o.label!, o);
      this.searchText.set(o, `${o.name} ${o.label} ${o.ein ?? ""}`.toLowerCase());
    }
    this.byRank = [...orgs].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || cmp(a.label!, b.label!));
    this.byName = [...orgs].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.label!, b.label!));
  }

  matches(o: CatalogOrg, q: string): boolean {
    return this.searchText.get(o)!.includes(q);
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The last two builds, newest first. The gateway serves whichever matches the on-chain root. */
export class BuildSet {
  readonly builds: Build[];

  constructor(builds: Build[]) {
    if (builds.length === 0) throw new Error("no catalogue builds loaded");
    this.builds = [...builds].sort((a, b) => cmp(b.builtAt, a.builtAt)).slice(0, 2);
  }

  get newest(): Build {
    return this.builds[0]!;
  }

  /** The build whose names root is `root`, else the newest. */
  select(root: Hex | null): Build {
    if (root) {
      const hit = this.builds.find((b) => b.namesRoot.toLowerCase() === root.toLowerCase());
      if (hit) return hit;
    }
    return this.newest;
  }
}

/** Loads each source (directory or http(s) base URL) and keeps the newest two. */
export async function loadBuilds(sources: string[]): Promise<BuildSet> {
  const builds = await Promise.all(sources.map(async (s) => new Build(await loadCatalog(s), s)));
  return new BuildSet(builds);
}
