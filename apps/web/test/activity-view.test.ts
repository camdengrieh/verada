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
