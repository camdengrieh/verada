/** Per-viewer privacy preferences. Stored only in this browser; every read and write tolerates blocked storage. */
import { isAnonNetworkId, type AnonNetworkId } from "./anon-networks";

const KEY = "varada:privacy";

/** At most this many of the user's own RPC endpoints are kept. */
export const MAX_USER_RPC_URLS = 5;

export interface PrivacyPrefs {
  /** Also send indexer (Varada API) requests through the anon network, so Varada never sees your IP. */
  routeIndexer: boolean;
  /** The first-visit privacy explainer has been shown (and dismissed) in this browser. */
  introSeen: boolean;
  /**
   * The user's own RPC endpoints, tried before the configured ones. Through the anon network by
   * default; the only endpoints used in direct mode. Absent when none are saved.
   */
  rpcUrls?: string[];
  /** Override of the build's anon network. Absent means the build's default. */
  network?: AnonNetworkId;
  /**
   * "Direct to my RPC": every chain read, account reads included, goes straight to `rpcUrls` with no
   * anon worker. Not private. Only ever true while at least one endpoint is saved.
   */
  directMode?: boolean;
}

const DEFAULTS: PrivacyPrefs = { routeIndexer: false, introSeen: false };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * One RPC endpoint in canonical form, or why it is refused: an absolute https URL (http only for
 * this machine), with no credentials and no query string. The trailing slash is trimmed.
 */
export function checkRpcUrl(raw: string): { url: string } | { error: string } {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "is not a full URL (start with https://)" };
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { error: local ? "must use http:// or https://" : "must use https:// (http:// only for localhost)" };
  }
  if (u.username || u.password) return { error: "must not contain a username or password" };
  if (u.search || u.hash || s.includes("?") || s.includes("#")) return { error: "must not contain a query string or fragment" };
  return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
}

/** Canonical, de-duplicated endpoints; invalid entries are dropped, and only the first five are kept. */
export function sanitizeRpcUrls(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const r = checkRpcUrl(item);
    if ("url" in r && !out.includes(r.url)) out.push(r.url);
    if (out.length === MAX_USER_RPC_URLS) break;
  }
  return out;
}

/** Parse the settings text box (one URL per line). Any invalid line or more than five URLs is an error. */
export function parseRpcUrlList(text: string): { urls: string[]; errors: string[] } {
  const urls: string[] = [];
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const r = checkRpcUrl(line);
    if ("error" in r) errors.push(`${line.trim()} ${r.error}.`);
    else if (!urls.includes(r.url)) urls.push(r.url);
  }
  if (urls.length > MAX_USER_RPC_URLS) errors.push(`Use at most ${MAX_USER_RPC_URLS} endpoints.`);
  return { urls, errors };
}

/** Drop invalid or meaningless fields, so what is stored and used is always well-formed. */
export function normalizePrivacyPrefs(v: Partial<PrivacyPrefs> | null | undefined): PrivacyPrefs {
  const out: PrivacyPrefs = { routeIndexer: v?.routeIndexer === true, introSeen: v?.introSeen === true };
  const rpcUrls = sanitizeRpcUrls(v?.rpcUrls);
  if (rpcUrls.length > 0) out.rpcUrls = rpcUrls;
  if (isAnonNetworkId(v?.network)) out.network = v.network;
  // Direct mode needs an endpoint of the user's own; without one it is off.
  if (v?.directMode === true && rpcUrls.length > 0) out.directMode = true;
  return out;
}

/** True when chain reads go straight to the user's own RPC (the setting is on and an endpoint is saved). */
export function directModeActive(prefs: PrivacyPrefs): boolean {
  return prefs.directMode === true && (prefs.rpcUrls?.length ?? 0) > 0;
}

export function readPrivacyPrefs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): PrivacyPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return normalizePrivacyPrefs(JSON.parse(raw) as Partial<PrivacyPrefs>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrivacyPrefs(prefs: PrivacyPrefs, storage: Pick<Storage, "setItem"> | undefined = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(normalizePrivacyPrefs(prefs)));
  } catch {
    // storage blocked: the preference lasts for this page load only
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
