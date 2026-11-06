import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@varada/sdk";
import { quoteInfo } from "@/lib/quote-info";
import { buildImpact, causeNameOfOrg, causeNameOfSlug, focusCauseNames, poolFigures, toLive, usdcToUsd, type DonationRow } from "@/lib/token-data";
import { profileLinks, safeHref, untilText, usdText } from "@/lib/token-view";

const A = `0x${"0a".repeat(32)}`;
const B = `0x${"0b".repeat(32)}`;

describe("cause names", () => {
  it("maps catalogue category slugs to the library's cause names", () => {
    expect(causeNameOfSlug("disaster-relief")).toBe("disaster");
    expect(causeNameOfSlug("hunger")).toBe("hunger");
    expect(causeNameOfSlug("children-youth")).toBe("children");
    expect(causeNameOfSlug("nonsense")).toBe("other");
    expect(causeNameOfSlug(undefined)).toBe("other");
    expect(causeNameOfOrg({ categories: ["wildlife", "animals"] })).toBe(causeNameOfSlug("wildlife"));
    expect(causeNameOfOrg(undefined)).toBe("other");
  });

  it("lists a focus's causes, and none when the focus is open to every category", () => {
    expect(focusCauseNames({ categoryMask: "6", regionMask: 1, categories: ["homelessness", "hunger"], regions: [] })).toEqual(["homeless", "hunger"]);
    expect(focusCauseNames({ categoryMask: "0", regionMask: 0, categories: [], regions: [] })).toEqual([]);
    expect(focusCauseNames({ categoryMask: "0", regionMask: 0, categories: CATEGORIES.map((c) => c.slug), regions: [] })).toEqual([]);
    expect(focusCauseNames(null)).toEqual([]);
  });
});

describe("live token view", () => {
  const body = {
    token: "0xabc",
    threshold: "5000000",
    initialCause: A,
    initialPeriod: "OneDay",
    quote: "0xq",
    rotation: { period: "OneDay", startedAt: "100", nextRotationAt: "86500" },
    designatedCause: { causeId: B },
    nextCause: { causeId: A, startsAt: "86500" },
    totals: { gross: "10", platform: "1", credited: "9", donated: "6", pending: "3" },
    causes: [{ causeId: B, gross: "10", platform: "1", credited: "9", donated: "6", pending: "3", donations: 2 }, { nope: true }],
    recentDonations: [{ id: "d", causeId: B, amount: "6", timestamp: "50", txHash: "0xtx" }, { id: "bad" }],
  };

  it("parses rotation, cadence, totals and recent donations, dropping malformed rows", () => {
    const v = toLive(body)!;
    expect(v.cadence).toBe("24h");
    expect(v.threshold).toBe(5_000_000n);
    expect(v.rotation).toEqual({ startedAt: 100, nextRotationAt: 86_500 });
    expect(v.designatedCause).toBe(B);
    expect(v.nextCause).toEqual({ causeId: A, startsAt: 86_500 });
    expect(v.totals).toEqual({ gross: 10n, platform: 1n, credited: 9n, donated: 6n, pending: 3n });
    expect(v.causes).toHaveLength(1);
    expect(v.recentDonations).toEqual([{ id: "d", causeId: B, amount: 6n, timestamp: 50, txHash: "0xtx" }]);
  });

  it("falls back to the initial cause and period before the rotation is indexed", () => {
    const v = toLive({ ...body, rotation: null, designatedCause: null, nextCause: null })!;
    expect(v.designatedCause).toBe(A);
    expect(v.cadence).toBe("24h");
    expect(v.rotation).toBeNull();
    expect(v.nextCause).toBeNull();
  });

  it("rejects anything that is not a live view", () => {
    expect(toLive(null)).toBeNull();
    expect(toLive({ error: "not_found" })).toBeNull();
    expect(toLive({ ...body, initialPeriod: "Fortnight", rotation: null })!.cadence).toBeNull();
  });
});

describe("pool figures", () => {
  it("splits a pool into what the epoch earned and what was carried in", () => {
    const f = poolFigures({
      epoch: "5",
      causePool: { attributed: "12000000", settledAmount: null, accruals: [{ accrualEpoch: "5", causeAmount: "9000000" }, { accrualEpoch: "4", causeAmount: "3000000" }] },
    });
    expect(f).toEqual({ total: 12_000_000n, earned: 9_000_000n, carriedIn: 3_000_000n, settled: null });
    expect(poolFigures({ epoch: "5", causePool: { attributed: "1", settledAmount: "1", accruals: [] } })!.settled).toBe(1n);
    expect(poolFigures({ epoch: "5" })).toBeNull();
    expect(poolFigures(null)).toBeNull();
  });
});

describe("impact", () => {
  const rows: DonationRow[] = [
    { id: "1", causeId: A, amount: 4_000_000n, timestamp: 100, txHash: "0x1", via: "pool" },
    { id: "2", causeId: B, amount: 1_000_000n, timestamp: 300, txHash: null, via: "pool" },
    { id: "3", causeId: A, amount: 2_000_000n, timestamp: 200, txHash: "0x3", via: "pool" },
  ];
  const meta = (id: string) => (id === A ? { name: "Alpha", cause: "hunger" as const } : { name: "Beta", cause: "water" as const });

  it("groups donations by category and charity and orders the timeline newest first", () => {
    const i = buildImpact(rows, meta, "MCAT", (h) => `https://scan/${h}`);
    expect(i.totalDonated).toBe(7);
    expect(i.items).toEqual([
      { cause: "hunger", amount: 6, charities: 1 },
      { cause: "water", amount: 1, charities: 1 },
    ]);
    expect(i.leaderboard.map((e) => [e.name, e.raised])).toEqual([["Alpha", 6], ["Beta", 1]]);
    expect(i.timeline.map((d) => d.id)).toEqual(["2", "3", "1"]);
    expect(i.timeline[1]).toMatchObject({ org: "Alpha", amount: 2, via: "pool", coin: "$MCAT", at: 200_000, txHref: "https://scan/0x3" });
    expect(i.timeline[0]!.txHref).toBeUndefined();
  });

  it("uses explicit per-cause totals for the breakdown when given", () => {
    const i = buildImpact(rows, meta, "MCAT", (h) => h, [{ causeId: B, amount: 9_000_000n }]);
    expect(i.items).toEqual([{ cause: "water", amount: 9, charities: 1 }]);
    expect(i.totalDonated).toBe(9);
    expect(i.timeline).toHaveLength(3);
  });

  it("converts USDC base units", () => {
    expect(usdcToUsd(1_234_567n)).toBeCloseTo(1.234567, 9);
    expect(usdcToUsd(0n)).toBe(0);
  });
});

describe("quote assets", () => {
  it("names WETH, USDC and Ondo tokens with their kind and whether an amount is dollars", () => {
    expect(quoteInfo("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")).toMatchObject({ symbol: "WETH", kind: "crypto", usd: false, ondo: false });
    expect(quoteInfo("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toMatchObject({ symbol: "USDC", usd: true });
    expect(quoteInfo("0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c")).toMatchObject({ symbol: "AAPLon", kind: "stock", ondo: true, usd: false });
    expect(quoteInfo("0x00000000000000000000000000000000000000aa")).toMatchObject({ kind: "crypto", ondo: false });
    expect(quoteInfo(null)).toBeNull();
  });
});

describe("profile links and text", () => {
  it("links http(s) records and expands bare handles, leaving anything else as text", () => {
    const links = profileLinks({ url: "https://mooncat.example/about", "com.twitter": "@mooncat", "org.telegram": "mooncat_chat", "com.discord": "mooncat#1", "com.github": "https://github.com/mooncat" });
    expect(links.map((l) => [l.key, l.href, l.text])).toEqual([
      ["url", "https://mooncat.example/about", "mooncat.example/about"],
      ["twitter", "https://x.com/mooncat", "@mooncat"],
      ["telegram", "https://t.me/mooncat_chat", "@mooncat_chat"],
      ["discord", null, "mooncat#1"],
      ["github", "https://github.com/mooncat", "github.com/mooncat"],
    ]);
  });

  it("never turns a script URL into a link", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(profileLinks({ url: "javascript:alert(1)" })[0]!.href).toBeNull();
    expect(profileLinks({ "com.twitter": "x y z" })[0]!.href).toBeNull();
    expect(profileLinks({})).toEqual([]);
  });

  it("writes time left and dollar amounts", () => {
    expect(untilText(1_000 + 2 * 86_400 + 4 * 3_600, 1_000_000)).toBe("2d 4h");
    expect(untilText(1_000 + 3_600 + 5 * 60, 1_000_000)).toBe("1h 5m");
    expect(untilText(1_000 + 30, 1_000_000)).toBe("1m");
    expect(untilText(1_000, 2_000_000)).toBe("");
    expect(usdText(1234.5)).toBe("$1,234.50");
    expect(usdText(1_250_000, true)).toBe("$1.25M");
  });
});
