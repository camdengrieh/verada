"use client";

import type { ReactNode } from "react";
import { AssetProvider } from "@verada/ui/lib/assets";
import { useRel } from "@/components/nav";

/** Resolves site-relative asset paths for the current page depth (works under any Swarm/ENS prefix). */
export function DesignProviders({ children }: { children: ReactNode }) {
  const rel = useRel();
  return <AssetProvider resolve={rel}>{children}</AssetProvider>;
}
