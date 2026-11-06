// Written for Varada
import { Badge, type BadgeProps } from "@verada/ui/components/ui/badge";

/** How often a live-donation coin rotates to the next charity. */
export type LiveCadence = "1h" | "12h" | "24h" | "72h" | "week";

/** A coin's giving mode: weekly pool, or live donation with a rotation cadence. */
export type GivingMode = { mode: "weekly" } | { mode: "live"; cadence: LiveCadence };

export interface ModeBadgeProps extends Omit<BadgeProps, "tone" | "dot" | "children"> {
  giving: GivingMode;
  /** "Live donation · 24h" instead of "Live · 24h". */
  long?: boolean;
}

export function givingModeLabel(giving: GivingMode, long = false): string {
  if (giving.mode === "weekly") return "Weekly pool";
  return `${long ? "Live donation" : "Live"} · ${giving.cadence}`;
}

/** Weekly pool (sage) or live donation with its rotation cadence (terracotta, with a dot). */
export function ModeBadge({ giving, long, ...props }: ModeBadgeProps) {
  const title =
    giving.mode === "weekly"
      ? "Fees pool for 7 days, then holders' private vote picks the charity"
      : `Each trade donates straight away; the charity rotates every ${giving.cadence}`;
  return (
    <Badge tone={giving.mode === "weekly" ? "cause" : "live"} dot={giving.mode === "live"} title={title} {...props}>
      {givingModeLabel(giving, long)}
    </Badge>
  );
}
