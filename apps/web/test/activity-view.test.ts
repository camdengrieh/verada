import { describe, expect, it } from "vitest";
import { activityRow } from "@/lib/activity-view";
import { toActivity } from "@/lib/indexer";

describe("live donation activity", () => {
  it("parses and renders a live_donation item", () => {
    const item = toActivity({
      id: "live_donation:0xabc-1",
      kind: "live_donation",
      timestamp: "1700000000",
      token: "0x1234567890abcdef1234567890abcdef12345678",
      txHash: "0xdead",
      data: { causeId: "0xcafe000000000000000000000000000000000000000000000000000000000001", org: "0x00000000000000000000000000000000000000a1", amount: "3500000", orgDeployed: true, inSwap: true },
    });
    expect(item?.kind).toBe("live_donation");
    const row = activityRow(item!);
    expect(row).toMatchObject({ kind: "give", tag: "Live gift", amount: "$3.5", amountTone: "cause", dateTime: "2023-11-14T22:13:20.000Z" });
    expect(row?.meta).toContain("in a swap");
  });

  it("labels a flush and ignores other kinds", () => {
    const flush = toActivity({ id: "x", kind: "live_donation", timestamp: 1, data: { amount: "1000000", inSwap: false } });
    expect(activityRow(flush!)?.meta).toBe("by flush");
    expect(activityRow(toActivity({ id: "y", kind: "launch", data: {} })!)).toBeNull();
  });
});

describe("feed rows with a context", () => {
  const ctx = {
    symbolOf: (t: string | undefined) => (t === "0xa1" ? "HARAMBE" : undefined),
    quoteOf: (q: string | undefined) => (q === "0xweth" ? { symbol: "WETH", decimals: 18 } : undefined),
    causeOf: (c: string | undefined) => (c === "0xcause" ? { name: "Wildlife Conservation Network", cause: "wildlife" as const } : undefined),
    nowSeconds: 1_000_300,
  };

  it("names the cause of a live donation instead of its hash", () => {
    const item = toActivity({ id: "l1", kind: "live_donation", timestamp: 1_000_000, token: "0xa1", data: { causeId: "0xcause", amount: "2000000", inSwap: true } })!;
    const row = activityRow(item, ctx);
    expect(row?.title).toBe("Donated to Wildlife Conservation Network");
    expect(row?.time).toBe("5 min ago");
    const unknown = toActivity({ id: "l2", kind: "live_donation", timestamp: 1, data: { causeId: `0x${"ab".repeat(32)}`, amount: "1" } })!;
    expect(activityRow(unknown, ctx)?.title).toBe("Donated to 0xabab...abab");
  });

  it("renders trades without the trader and weekly payouts with the cause name", () => {
    const buy = toActivity({ id: "t1", kind: "trade", timestamp: 1_000_000, token: "0xa1", data: { side: "buy", quote: "0xweth", quoteAmount: (10n ** 18n).toString(), trader: "0xf9" } })!;
    expect(activityRow(buy, ctx)).toMatchObject({ kind: "buy", title: "Bought $HARAMBE", amount: "1 WETH" });
    expect(JSON.stringify(activityRow(buy, ctx))).not.toContain("0xf9");
    const gift = toActivity({ id: "d1", kind: "donation", timestamp: 1_000_000, token: "0xa1", data: { amount: "4500000", causeId: "0xcause" } })!;
    expect(activityRow(gift, ctx)).toMatchObject({ kind: "give", title: "$HARAMBE gave to Wildlife Conservation Network", amount: "$4.5" });
    expect(activityRow(toActivity({ id: "v", kind: "vote", data: {} })!, ctx)).toBeNull();
  });
});
