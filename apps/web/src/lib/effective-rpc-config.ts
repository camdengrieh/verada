/**
 * The private-RPC config this browser actually uses: the build's config (config.json and
 * NEXT_PUBLIC_* values) with the user's connection settings from privacy-prefs applied on top.
 * Pure, so a change of settings can rebuild the PrivateRpc from it.
 */
import type { PrivateRpcConfig } from "./config";
import { directModeActive, sanitizeRpcUrls, type PrivacyPrefs } from "./privacy-prefs";

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * The user's own RPCs go first, ahead of the configured ones (de-duplicated). In direct mode they
 * are the only ones, since direct mode means "only my RPC sees my reads". A chosen network
 * replaces the build's; the build's specifier, worker config and bootstrap RPC belong to the
 * build's network, so they are dropped when the user picks a different one.
 */
export function effectivePrivateRpcConfig(base: PrivateRpcConfig, prefs: PrivacyPrefs): PrivateRpcConfig {
  const own = sanitizeRpcUrls(prefs.rpcUrls);
  const rpcUrls: string[] = [];
  const list = directModeActive({ ...prefs, rpcUrls: own }) ? own : [...own, ...base.rpcUrls.map(trimSlash)];
  for (const u of list) if (!rpcUrls.includes(u)) rpcUrls.push(u);

  const cfg: PrivateRpcConfig = { ...base, rpcUrls };
  if (prefs.network && prefs.network !== base.network) {
    cfg.network = prefs.network;
    delete cfg.specifier;
    delete cfg.workerConfig;
    delete cfg.bootstrapRpcUrl;
  }
  return cfg;
}
