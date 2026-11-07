/**
 * What the chat knows about a cause: its agent record, latest report and donor leaderboard, read
 * from the indexer's public routes. Cached per cause so concurrent chats share one fetch and the
 * prompt bytes stay identical (which keeps the prompt cache warm).
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CauseContext {
  label: string;
  /** Present once the cause is registered on chain. */
  agent: unknown | null;
  report: unknown | null;
  donors: unknown | null;
  /** Serialized once; this exact string goes into the prompt. */
  text: string;
}

/** Cause labels (`ensLabel` in packages/sdk), the same twenty the CLI knows. */
export const CAUSE_LABELS = [
  "disaster", "homeless", "hunger", "children", "disease", "cancer", "wildlife", "animals", "environment", "water",
  "health", "mental-health", "research", "education", "refugees", "human-rights", "women", "poverty", "veterans", "justice",
] as const;

export function isCause(label: string): boolean {
  return (CAUSE_LABELS as readonly string[]).includes(label);
}

async function getJson(fetchFn: Fetch, url: string): Promise<unknown | null> {
  const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

function latestEpoch(agent: unknown): string | null {
  const reports = (agent as { reports?: { epoch?: unknown }[] } | null)?.reports;
  const e = reports?.[0]?.epoch;
  return typeof e === "string" || typeof e === "number" ? String(e) : null;
}

export async function loadCauseContext(indexerUrl: string, label: string, fetchFn: Fetch = fetch): Promise<CauseContext> {
  const base = `${indexerUrl}/api/agents/${encodeURIComponent(label)}`;
  const [agent, donors] = await Promise.all([getJson(fetchFn, base), getJson(fetchFn, `${base}/donors?days=7&limit=10`).catch(() => null)]);
  const epoch = latestEpoch(agent);
  const report = epoch ? await getJson(fetchFn, `${base}/reports/${epoch}`).catch(() => null) : null;
  const text = JSON.stringify({ cause: label, agent, latestReport: report, donorsLast7Days: donors });
  return { label, agent, report, donors, text };
}

/** Per-cause cache with a TTL and in-flight de-duplication. Failures are not cached. */
export function contextCache(
  load: (label: string) => Promise<CauseContext>,
  ttlMs: number,
  now: () => number = Date.now,
): (label: string) => Promise<CauseContext> {
  const hits = new Map<string, { at: number; value: Promise<CauseContext> }>();
  return (label) => {
    const hit = hits.get(label);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load(label);
    hits.set(label, { at: now(), value });
    value.catch(() => hits.delete(label));
    return value;
  };
}
