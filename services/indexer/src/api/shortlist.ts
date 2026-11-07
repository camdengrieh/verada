import type { Hex } from "viem";
import type { ShortlistSchedule } from "./types";

/**
 * Splits a stored schedule into the list in effect for `current` and the pending one. A pending
 * list may be empty (a token returning to the default). Without a schedule a scheduled list is
 * reported as pending, which is what it is unless it was applied immediately.
 */
export function resolveSchedule(
  s: ShortlistSchedule | null,
  current: bigint | null,
): { inEffect: Hex[]; pending: { causeIds: Hex[]; effectiveFrom: bigint } | null } {
  if (!s) return { inEffect: [], pending: null };
  if (s.effectiveFrom === null) return { inEffect: s.causeIds, pending: null };
  if (current !== null && current >= s.effectiveFrom) return { inEffect: s.causeIds, pending: null };
  return {
    inEffect: s.previousCauseIds,
    pending: { causeIds: s.causeIds, effectiveFrom: s.effectiveFrom },
  };
}
