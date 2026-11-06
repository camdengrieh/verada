"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * How components turn a site-relative asset path (e.g. "assets/causes/water-128.webp") into a URL.
 * The static site is served under /bzz/<ref>/, bzz subdomains and ENS gateways, so the app supplies
 * a resolver that knows the current page depth. Pack images (stock logos) come from the Swarm
 * gateway instead and are passed to components as ready URLs.
 */
export type AssetResolver = (path: string) => string;

const AssetContext = createContext<AssetResolver>((path) => path);

export function AssetProvider({ resolve, children }: { resolve: AssetResolver; children: ReactNode }) {
  return <AssetContext.Provider value={resolve}>{children}</AssetContext.Provider>;
}

/** The current resolver; returns paths unchanged outside a provider (tests, isolated stories). */
export function useAssetUrl(): AssetResolver {
  return useContext(AssetContext);
}
