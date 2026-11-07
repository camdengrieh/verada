import { CATEGORIES } from "@varada/sdk";
import { IndexerError, type CatalogOrg, type IndexerClient } from "./indexer";

/**
 * Varada's ENS names: one `<label>.org.<parent>` per catalogue charity (ENSv2, owned on Optimism,
 * resolved through VaradaOrgResolver), plus `agent.<parent>` and one `<cause>.agent.<parent>` per
 * curator agent. Charity names are searched and counted through the indexer's catalogue routes
 * (`/api/catalog/search`, `/api/catalog` `names`); the agent names come from the SDK taxonomy,
 * which `SetupAgentNames.s.sol` registers label for label.
 */

/** Namespace label of the charity names: `<label>.org.<parent>`. */
export const ORG_NAMESPACE = "org";
/** Namespace label of the curator agents: `<cause>.agent.<parent>`. */
export const AGENT_NAMESPACE = "agent";

/** Results per search page. */
export const NAME_PAGE = 20;
/** Shortest query sent to the indexer (one letter matches most of the catalogue). */
export const MIN_QUERY = 2;
/** The indexer reads at most 100 characters of a query. */
export const MAX_QUERY = 100;

export const orgEnsName = (label: string, parent: string) => `${label}.${ORG_NAMESPACE}.${parent}`;

export interface AgentName {
  /** Full ENS name. */
  name: string;
  /** What it is: "Curator agents" for the index, else the cause's label. */
  title: string;
  /** Category slug; null for the `agent.<parent>` index. */
  slug: string | null;
  /** Site path of the agent's page (relative to the site root). */
  path: string;
}

/** `agent.<parent>` and every curator agent's `<cause>.agent.<parent>`, in taxonomy order. */
export function agentNames(parent: string): AgentName[] {
  return [
    { name: `${AGENT_NAMESPACE}.${parent}`, title: "Curator agents", slug: null, path: `${AGENT_NAMESPACE}/` },
    ...CATEGORIES.flatMap((c) =>
      c.ensLabel ? [{ name: `${c.ensLabel}.${AGENT_NAMESPACE}.${parent}`, title: c.label, slug: c.slug, path: `${AGENT_NAMESPACE}/${c.ensLabel}/` }] : [],
    ),
  ];
}

/** How many agent names exist (`agent.<parent>` and one per curator agent). */
export const AGENT_NAME_COUNT = agentNames("varada.eth").length;

/** The query as sent: trimmed, single spaces, lowercased, at most {@link MAX_QUERY} characters. */
export function normalizeNameQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase().slice(0, MAX_QUERY);
}

/** Agent names matching `q` by name or cause (empty below {@link MIN_QUERY} characters). */
export function matchAgentNames(q: string, parent: string): AgentName[] {
  const needle = normalizeNameQuery(q);
  if (needle.length < MIN_QUERY) return [];
  return agentNames(parent).filter((a) => a.name.includes(needle) || a.title.toLowerCase().includes(needle));
}

export interface NamesCount {
  /** `<label>.org.<parent>` names in the loaded catalogue build. */
  orgNames: number;
  /** `agent.<parent>` and the curator agents' names. */
  agentNames: number;
  total: number;
  /** `VaradaOrgResolver.root()` of the build counted. */
  namesRoot: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `names` part of `/api/catalog`, or null when the indexer does not report one. */
export function parseNamesCount(v: unknown): NamesCount | null {
  if (!isRecord(v) || !isRecord(v.names)) return null;
  const count = v.names.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  const root = typeof v.names.root === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.names.root) ? v.names.root.toLowerCase() : null;
  return { orgNames: count, agentNames: AGENT_NAME_COUNT, total: count + AGENT_NAME_COUNT, namesRoot: root };
}

/**
 * Registered names, from the catalogue the indexer has loaded. Null when it has no catalogue (503),
 * no such route (404) or a build without names: the count is then unknown, never zero.
 */
export async function fetchNamesCount(client: Pick<IndexerClient, "get">): Promise<NamesCount | null> {
  try {
    return parseNamesCount(await client.get("/api/catalog"));
  } catch (e) {
    if (e instanceof IndexerError && (e.status === 503 || e.status === 404)) return null;
    throw e;
  }
}

/** A charity's name; orgs from builds without names have none and are left out of name search. */
export interface OrgNameHit {
  label: string;
  ensName: string;
  org: CatalogOrg;
}

export const toNameHits = (orgs: readonly CatalogOrg[], parent: string): OrgNameHit[] =>
  orgs.flatMap((org) => (org.label ? [{ label: org.label, ensName: orgEnsName(org.label, parent), org }] : []));

/** Site paths (relative to the site root) a result links to. */
export const namePaths = {
  /** Give to this charity directly (`/donate/?org=`). */
  donate: (orgId: string) => `donate/?org=${encodeURIComponent(orgId.toLowerCase())}`,
  /** The charity in the catalogue browser (the label is its exact match). */
  catalogue: (label: string) => `causes/?q=${encodeURIComponent(label)}`,
  /** Every charity of a cause. */
  cause: (slug: string) => `causes/?category=${encodeURIComponent(slug)}`,
};
