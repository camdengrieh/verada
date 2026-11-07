/**
 * Depth ordering for pair lists, as a pure function of `{ symbol, depthUsd }` so any price layer can
 * feed it. Deepest first; ties by symbol (stable, locale-independent); assets with no route to USDC
 * (no depth, or `routed: false`) come last.
 */
export interface DepthOrdered {
  symbol: string;
  /** USD depth of the route to USDC. 0, missing or NaN: none. */
  depthUsd?: number | null;
  /** False when there is no route at all, whatever `depthUsd` says. Default: depth above zero. */
  routed?: boolean;
  /** Secondary depth (the asset's own pool), used before the symbol on equal route depth. */
  poolDepthUsd?: number | null;
}

const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function isRouted(a: DepthOrdered): boolean {
  return a.routed ?? num(a.depthUsd) > 0;
}

export function compareByDepth(a: DepthOrdered, b: DepthOrdered): number {
  return (
    Number(isRouted(b)) - Number(isRouted(a)) ||
    num(b.depthUsd) - num(a.depthUsd) ||
    num(b.poolDepthUsd) - num(a.poolDepthUsd) ||
    (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)
  );
}

export type FillStatus = "ok" | "thin" | "cant-fill";

/**
 * Whether fees in an asset can be sold into USDC at size: "cant-fill" with no route or no depth,
 * "thin" under the minimum route depth, else "ok". USDC itself (`direct`) is always "ok".
 */
export function fillStatus(a: { routed: boolean; depthUsd?: number | null; direct?: boolean }, minDepthUsd: number): FillStatus {
  if (a.direct) return "ok";
  if (!a.routed || num(a.depthUsd) <= 0) return "cant-fill";
  return num(a.depthUsd) < minDepthUsd ? "thin" : "ok";
}

/** A new array, deepest first. */
export function sortByDepth<T extends DepthOrdered>(items: readonly T[]): T[] {
  return [...items].sort(compareByDepth);
}
