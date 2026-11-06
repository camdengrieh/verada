import { describe, expect, it } from "vitest";
import { EXTERNAL_ADDRESSES } from "@varada/sdk";
import { donationAssetHint, donationUnitOf, usdcScaled } from "@/lib/donation-asset";
import { formatDonation } from "@/lib/format";
import { initialWizardState, toLaunchInput } from "@/lib/launch-steps";
import { DEFAULT_DONATION_THRESHOLD, parseLaunchInput } from "@/lib/launch";
import { launchCall } from "@/lib/launch-tx";
import { leaderboardInUsd, toLeaderboardPage } from "@/lib/causes-client";
import { usdcToUsd } from "@/lib/token-data";
import { toFinalizedEpoch, toPoolDonation, causeLeaderboard } from "@/lib/governance";
import { liveDonationRow } from "@/lib/activity-view";
import { toCardToken, maxRaisedOf, type CardContext } from "@/lib/discover";

const SALT = `0x${"11".repeat(32)}`;
const filled = () => {
  const s = initialWizardState(SALT);
  return { ...s, input: { ...s.input, name: "Test Coin", symbol: "TEST", label: "test-coin" }, logoRef: "cd".repeat(32) };
};
const ONE_ETH = 10n ** 18n;

describe("launch params carry the donation asset", () => {
  it("defaults to USDC (enum 0)", () => {
    const r = parseLaunchInput(toLaunchInput(filled()));
    expect(r.ok && r.params.donationAsset).toBe(0);
  });

  it("encodes ETH as enum 1 and passes it to the factory call", () => {
    const s = filled();
    const r = parseLaunchInput({ ...toLaunchInput(s), donationAsset: "eth" });
    expect(r.ok && r.params.donationAsset).toBe(1);
    if (!r.ok) throw new Error(r.error);
    const call = launchCall("0x00000000000000000000000000000000000000f1", r.params, "bzz://x");
    expect(call.functionName).toBe("deployToken");
    expect((call.args[0] as { donationAsset: number }).donationAsset).toBe(1);
  });

  it("writes the live threshold in the chosen asset", () => {
    const base = { ...toLaunchInput(filled()), mode: "live" as const, initialCause: `0x${"ab".repeat(32)}` };
    const eth = parseLaunchInput({ ...base, donationAsset: "eth", donationThreshold: DEFAULT_DONATION_THRESHOLD.eth });
    expect(eth.ok && eth.live?.donationThreshold).toBe(10n ** 16n);
    const usdc = parseLaunchInput({ ...base, donationAsset: "usdc", donationThreshold: "25" });
    expect(usdc.ok && usdc.live?.donationThreshold).toBe(25_000_000n);
    // 25 ETH-units of USDC precision are not valid ETH-units of 18 decimals: 19 decimals fail.
    expect(parseLaunchInput({ ...base, donationAsset: "eth", donationThreshold: "0.0000000000000000001" }).ok).toBe(false);
    expect(parseLaunchInput({ ...base, donationAsset: "eth", donationThreshold: "0" }).ok).toBe(false);
  });

  it("rejects an unknown asset", () => {
    expect(parseLaunchInput({ ...toLaunchInput(filled()), donationAsset: "dai" as never }).ok).toBe(false);
  });
});

describe("which asset suits a pair", () => {
  it("favours ETH for WETH and USDC for USDC", () => {
    expect(donationAssetHint(EXTERNAL_ADDRESSES.weth).suggest).toBe("eth");
    expect(donationAssetHint(EXTERNAL_ADDRESSES.usdc).suggest).toBe("usdc");
  });
  it("compares depths when both are known", () => {
    const ondo = "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c";
    expect(donationAssetHint(ondo, { usdcDepthUsd: 400_000, ethDepthUsd: 50_000 }).suggest).toBe("usdc");
    expect(donationAssetHint(ondo, { usdcDepthUsd: 10_000, ethDepthUsd: 90_000 }).suggest).toBe("eth");
  });
  it("calls a thin USDC route thin and a missing read unknown", () => {
    const ondo = "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c";
    expect(donationAssetHint(ondo, { usdcDepthUsd: 1_000 })).toMatchObject({ suggest: null });
    expect(donationAssetHint(ondo, { usdcDepthUsd: 1_000 }).text).toMatch(/thin/);
    expect(donationAssetHint(ondo).suggest).toBeNull();
  });
});

describe("amounts in ETH units", () => {
  it("converts wei to dollars at the price, USDC at par", () => {
    expect(usdcToUsd(ONE_ETH, donationUnitOf("eth", 3000))).toBe(3000);
    expect(usdcToUsd(12_500_000n, donationUnitOf("usdc", null))).toBe(12.5);
    expect(usdcToUsd(ONE_ETH, donationUnitOf("eth", null))).toBe(0);
  });
  it("scales to USDC base units for comparison", () => {
    expect(usdcScaled(ONE_ETH, "eth", 2500)).toBe(2_500_000_000n);
    expect(usdcScaled(7n, "usdc", 2500)).toBe(7n);
  });
  it("formats ETH as dollars when priced and in ETH when not", () => {
    expect(formatDonation(ONE_ETH / 2n, "eth", 3000)).toBe("$1.5K");
    expect(formatDonation(ONE_ETH / 4n, "eth", null)).toBe("0.25 ETH");
    expect(formatDonation(12_500_000n, "usdc", 3000)).toBe("$12.5");
  });
});

describe("cause totals mix both assets", () => {
  const page = toLeaderboardPage({
    totals: { causes: 2, donations: 3, donated: "1000000000", donatedEth: ONE_ETH.toString() },
    items: [
      { rank: 1, causeId: "0xa", donated: "1000000000", donatedEth: "0", donations: 1, tokens: 1 },
      { rank: 2, causeId: "0xb", donated: "0", donatedEth: ONE_ETH.toString(), donations: 2, tokens: 1 },
    ],
    byCategory: [{ slug: "hunger", donated: "0", donatedEth: ONE_ETH.toString(), donations: 2, causes: 1 }],
    nextCursor: null,
  })!;
  it("parses donatedEth", () => {
    expect(page.items[1]!.donatedEth).toBe(ONE_ETH);
    expect(page.totals.donatedEth).toBe(ONE_ETH);
  });
  it("folds ETH into dollars and re-ranks by the live price", () => {
    const low = leaderboardInUsd(page, 500);
    expect(low.items.map((i) => i.causeId)).toEqual(["0xa", "0xb"]);
    const high = leaderboardInUsd(page, 5000);
    expect(high.items.map((i) => i.causeId)).toEqual(["0xb", "0xa"]);
    expect(high.items[0]!.donated).toBe(5_000_000_000n);
    expect(high.totals.donated).toBe(6_000_000_000n);
    expect(high.byCategory[0]!.donated).toBe(5_000_000_000n);
  });
});

describe("feeds read the donation asset of an item", () => {
  const item = (asset: string) => ({ id: "live_donation:1", kind: "live_donation", timestamp: 100, token: "0xt", txHash: null, data: { amount: ONE_ETH.toString(), causeId: "0xc", org: "0xo", inSwap: true, donationAsset: asset } }) as never;
  const ctx = { nowSeconds: 200, symbolOf: () => "T", quoteOf: () => undefined, causeOf: () => undefined, usdOf: () => ({ priceUsd: 2000 }) } as never;
  it("prices ETH gifts with the WETH quote", () => {
    expect(liveDonationRow(item("eth"), ctx)!.amount).toBe("$2K");
  });
  it("shows ETH itself when there is no price", () => {
    const noPrice = { ...(ctx as object), usdOf: () => undefined } as never;
    expect(liveDonationRow(item("eth"), noPrice)!.amount).toBe("1 ETH");
  });
  it("treats an untagged item as USDC", () => {
    const row = liveDonationRow({ ...(item("usdc") as object), data: { amount: "2500000", causeId: "0xc" } } as never, ctx);
    expect(row!.amount).toBe("$2.5");
  });
  it("carries the asset into pool donations and epochs", () => {
    const d = toPoolDonation({ id: "d", kind: "donation", timestamp: 1, token: "0xt", txHash: null, data: { causeId: "0xc", amount: "5", epoch: "1", donationAsset: "eth" } } as never)!;
    expect(d.donationAsset).toBe("eth");
    const e = toFinalizedEpoch({ id: "e", kind: "epoch", timestamp: 1, token: "0xt", txHash: null, data: { epoch: "1", donatedAmount: "5" } } as never)!;
    expect(e.donationAsset).toBe("usdc");
    const labels = { cause: () => ({ name: "n", category: "other" as const }), token: () => "" };
    const eth = { ...d, amount: ONE_ETH.toString() };
    const usdc = { ...d, donationAsset: "usdc" as const, amount: "1000000" };
    expect(causeLeaderboard([eth, usdc], labels, 3000)[0]!.raised).toBe(3001);
  });
});

describe("discover cards", () => {
  const token = (donationAsset: "usdc" | "eth", raised: bigint) => ({ address: "0xabc", name: "n", symbol: "N", label: null, logoRef: null, createdAt: 1, feeBps: 300, focus: null, raised, donationAsset, mode: { kind: "weekly" }, market: null }) as never;
  const ctx = (ethUsd: number | null, max: bigint) => ({ parent: "varada.eth", assets: [], logo: () => undefined, maxRaised: max, ethUsd }) as CardContext;
  it("compares ETH and USDC raised in dollars", () => {
    const tokens = [token("usdc", 1_000_000_000n), token("eth", ONE_ETH)];
    expect(maxRaisedOf(tokens, 3000)).toBe(3_000_000_000n);
    expect(toCardToken(tokens[0]!, ctx(3000, 3_000_000_000n)).raisedPct).toBe(33);
    expect(toCardToken(tokens[1]!, ctx(3000, 3_000_000_000n))).toMatchObject({ raised: "$3K", raisedPct: 100 });
  });
});
