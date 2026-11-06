import type { ActivityItem as FeedRow } from "@varada/ui/components/data/activity-list";
import { formatUsdc } from "./agents";
import type { ActivityItem } from "./indexer";

const short = (v: string) => (v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v);

/**
 * Feed row for a `live_donation` item: USDC the live vault sent to a cause's org, in a swap or by
 * `flush`. The event names no donor, so the row shows only the cause and the org.
 */
export function liveDonationRow(item: ActivityItem): FeedRow | null {
  if (item.kind !== "live_donation") return null;
  const raw = item.data.amount;
  const amount = typeof raw === "string" || typeof raw === "bigint" ? formatUsdc(raw) : "0";
  const cause = typeof item.data.causeId === "string" ? short(item.data.causeId) : "cause";
  const org = typeof item.data.org === "string" ? short(item.data.org) : null;
  return {
    id: item.id,
    kind: "give",
    tag: "Live gift",
    title: `Donated to ${cause}`,
    meta: [org ? `org ${org}` : null, item.data.inSwap === true ? "in a swap" : "by flush"].filter(Boolean).join(" · "),
    amount: `$${amount}`,
    amountTone: "cause",
    dateTime: item.timestamp === undefined ? undefined : new Date(item.timestamp * 1000).toISOString(),
  };
}

/** Maps an indexer activity item to a feed row; kinds without a row yet give null. */
export function activityRow(item: ActivityItem): FeedRow | null {
  return liveDonationRow(item);
}
