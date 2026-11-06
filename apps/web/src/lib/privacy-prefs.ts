/** Per-viewer privacy preferences. Stored only in this browser; every read and write tolerates blocked storage. */
const KEY = "varada:privacy";

export interface PrivacyPrefs {
  /** Also send indexer (Varada API) requests through the anon network, so Varada never sees your IP. */
  routeIndexer: boolean;
  /** The first-visit privacy explainer has been shown (and dismissed) in this browser. */
  introSeen: boolean;
}

const DEFAULTS: PrivacyPrefs = { routeIndexer: false, introSeen: false };

export function readPrivacyPrefs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): PrivacyPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<PrivacyPrefs>;
    return { routeIndexer: v.routeIndexer === true, introSeen: v.introSeen === true };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrivacyPrefs(prefs: PrivacyPrefs, storage: Pick<Storage, "setItem"> | undefined = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
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
