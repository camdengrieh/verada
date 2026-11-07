"use client";

import { usdNotes, usdValue, type UsdQuote } from "@varada/sdk";
import { formatUsdValue } from "@/lib/format";

/**
 * The dollar value of an amount of a quote asset, as small print next to the amount in the asset's
 * own units: "~$1.2K". Renders nothing without a price. A thin pool or a closed US market adds the
 * "~" and, with `notes`, the reason.
 */
export function UsdEquiv({ units, usd, notes = false, className }: { units: number; usd: UsdQuote | null | undefined; notes?: boolean; className?: string }) {
  const v = usdValue(units, usd);
  if (!v || !Number.isFinite(v.usd)) return null;
  const why = notes ? usdNotes(usd) : [];
  return (
    <span className={className}>
      <span className="num" title={v.approx ? "Approximate: priced from the pools on chain" : "Priced from the pools on chain"}>
        {formatUsdValue(v.usd, v.approx)}
      </span>
      {why.length > 0 ? <span className="block text-xs font-normal text-ink-muted">{why.join(" ")}</span> : null}
    </span>
  );
}
