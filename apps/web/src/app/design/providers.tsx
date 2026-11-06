"use client";

import type { ReactNode } from "react";
import { AssetProvider } from "@varada/ui/lib/assets";
import { siteBase } from "@/lib/base";

/**
 * Resolves site-relative asset paths against the site root, so they work under any Swarm/ENS prefix.
 * siteBase() reads the location, not the layout segments: useRel() in a nested layout only counts the
 * segments below that layout and would resolve from the wrong directory.
 */
const resolve = (path: string) => `${siteBase()}${path.replace(/^\//, "")}`;

export function DesignProviders({ children }: { children: ReactNode }) {
  return <AssetProvider resolve={resolve}>{children}</AssetProvider>;
}
