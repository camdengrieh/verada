import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  DONATION_ASSET_ENUM,
  EXTERNAL_ADDRESSES,
  donationAmountText,
  donationAssetInfo,
  donationAssetOrDefault,
  donationToUsd,
  formatDonationAmount,
  parseDonationAmount,
  parseDonationAsset,
  readDonationAssetOf,
} from "../src/index.js";

describe("donation asset", () => {
  it("maps the contract enum both ways, unknown to null", () => {
    expect(DONATION_ASSET_ENUM).toEqual({ usdc: 0, eth: 1 });
    expect([0, 0n, "0", "usdc"].map(parseDonationAsset)).toEqual(["usdc", "usdc", "usdc", "usdc"]);
    expect([1, 1n, "1", "eth"].map(parseDonationAsset)).toEqual(["eth", "eth", "eth", "eth"]);
    expect(parseDonationAsset(2)).toBeNull();
    expect(donationAssetOrDefault(undefined)).toBe("usdc");
  });

  it("knows decimals and the ERC-20 each ledger is held in", () => {
    expect(donationAssetInfo("usdc")).toMatchObject({ symbol: "USDC", decimals: 6, token: EXTERNAL_ADDRESSES.usdc });
    expect(donationAssetInfo("eth")).toMatchObject({ symbol: "ETH", decimals: 18, token: EXTERNAL_ADDRESSES.weth });
  });

  it("formats and parses amounts in each asset's decimals", () => {
    expect(formatDonationAmount(1_500_000n, "usdc")).toBe("1.5");
    expect(formatDonationAmount(4n * 10n ** 15n, "eth")).toBe("0.004");
    expect(donationAmountText(10n ** 18n, "eth")).toBe("1 ETH");
    expect(parseDonationAmount("0.004", "eth")).toBe(4n * 10n ** 15n);
    expect(parseDonationAmount("25", "usdc")).toBe(25_000_000n);
    expect(parseDonationAmount("1.0000001", "usdc")).toBeNull();
    expect(parseDonationAmount("1e3", "eth")).toBeNull();
    for (const a of ["usdc", "eth"] as const) expect(parseDonationAmount(formatDonationAmount(123_456_789n, a), a)).toBe(123_456_789n);
  });

  it("converts to dollars, needing a price only for ETH", () => {
    expect(donationToUsd(2_500_000n, "usdc", null)).toBe(2.5);
    expect(donationToUsd(10n ** 18n, "eth", 3000)).toBe(3000);
    expect(donationToUsd(10n ** 18n, "eth", null)).toBeNull();
    expect(donationToUsd("0", "eth", 3000)).toBe(0);
  });

  it("reads donationAssetOf from the factory", async () => {
    const calls: unknown[] = [];
    const client = {
      readContract: async (a: { functionName: string; args: readonly unknown[] }) => {
        calls.push(a);
        return 1;
      },
    };
    const factory = getAddress("0x00000000000000000000000000000000000000f1");
    const token = getAddress("0x00000000000000000000000000000000000000a1");
    expect(await readDonationAssetOf(client, factory, token)).toBe("eth");
    expect(calls[0]).toMatchObject({ functionName: "donationAssetOf", args: [token] });
  });
});
