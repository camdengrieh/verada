import { describe, expect, it } from "vitest";
import { donationAmount, mergeActivity, toFeedItem, toTickerItem, type ActivityContext } from "@/lib/activity";
import type { ActivityItem } from "@/lib/indexer";

const ctx: ActivityContext = {
  symbolOf: (t) => (t === "0xa1" ? "HARAMBE" : undefined),
  quoteOf: (q) => (q === "0xweth" ? { symbol: "WETH", decimals: 18 } : undefined),
  causeOf: (c) => (c === "0xcause" ? { name: "Wildlife Conservation Network", cause: "wildlife" } : undefined),
  nowSeconds: 1_000_300,
};
const item = (kind: string, data: Record<string, unknown>, extra: Partial<ActivityItem> = {}): ActivityItem => ({
  id: `${kind}:1`,
  kind,
  token: "0xa1",
  timestamp: 1_000_000,
  data,
  ...extra,
});

describe("toTickerItem", () => {
  it("shows trades in the quote asset", () => {
    expect(toTickerItem(item("trade", { side: "buy", quote: "0xweth", quoteAmount: (10n ** 18n).toString() }), ctx)).toEqual({
      id: "trade:1",
      kind: "BUY",
      symbol: "$HARAMBE",
      text: "1 WETH",
    });
    expect(toTickerItem(item("trade", { side: "sell", quote: "0xweth", quoteAmount: "1" }), ctx)?.kind).toBe("SELL");
  });
  it("skips trades it cannot size", () => {
    expect(toTickerItem(item("trade", { side: "buy", quote: "0xother", quoteAmount: "5" }), ctx)).toBeNull();
    expect(toTickerItem(item("trade", { side: "flip", quote: "0xweth", quoteAmount: "5" }), ctx)).toBeNull();
  });
  it("shows donations with the cause name", () => {
    expect(toTickerItem(item("donation", { amount: "12400000", causeId: "0xcause" }), ctx)).toMatchObject({
      kind: "GIVE",
      text: "$12.4 to Wildlife Conservation Network",
    });
    expect(toTickerItem(item("donation", { amount: "1000000", causeId: "0x?" }), ctx)?.text).toBe("$1 to a cause");
  });
  it("names launches and votes, ignores the rest", () => {
    expect(toTickerItem(item("launch", {}), ctx)).toMatchObject({ kind: "NEW", text: "just launched" });
    expect(toTickerItem(item("vote", {}), ctx)).toMatchObject({ kind: "VOTE" });
    expect(toTickerItem(item("epoch", {}), ctx)).toBeNull();
    expect(toTickerItem(item("launch", {}, { token: "0xzz" }), ctx)?.symbol).toBe("a coin");
  });
});

describe("toFeedItem", () => {
  it("lists donations only", () => {
    expect(toFeedItem(item("donation", { amount: "2500000", causeId: "0xcause" }), ctx, true)).toEqual({
      id: "donation:1",
      symbol: "$HARAMBE",
      text: "gave to Wildlife Conservation Network",
      ago: "5 min ago",
      amount: "$2.5",
      cause: "wildlife",
      fresh: true,
    });
    expect(toFeedItem(item("trade", {}), ctx)).toBeNull();
    expect(donationAmount(item("donation", { amount: "7" }))).toBe(7n);
    expect(donationAmount(item("vote", {}))).toBeNull();
  });
});

describe("mergeActivity", () => {
  it("dedupes, orders newest first and caps", () => {
    const a = item("trade", {}, { id: "a", timestamp: 10 });
    const b = item("trade", {}, { id: "b", timestamp: 30 });
    const c = item("trade", {}, { id: "c", timestamp: 20 });
    expect(mergeActivity([a, c], [b, a]).map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(mergeActivity([a, c], [b], 2).map((i) => i.id)).toEqual(["b", "c"]);
  });
});
