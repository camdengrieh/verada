"use client";

import { useMemo } from "react";
import { donationAssetOrDefault, EXTERNAL_ADDRESSES, type DonationAsset } from "@varada/sdk";
import { USDC_UNIT, type DonationUnit } from "@/lib/token-data";
import { useQuoteUsd } from "./use-usd-quotes";

export interface DonationUnitInfo {
  asset: DonationAsset;
  /** How to turn base units into dollars. ETH uses the pools' WETH price (0 while unknown, see `priced`). */
  unit: DonationUnit;
  /** False only for ETH while no price is known: dollar figures are then not meaningful. */
  priced: boolean;
  /** "USDC" or "ETH". */
  symbol: string;
  /** USD per ETH, when known. */
  ethUsd: number | null;
}

/** The unit of a token's money amounts (fees, credits, donations): its donation asset, priced in USD. */
export function useDonationUnit(asset: DonationAsset | string | undefined | null): DonationUnitInfo {
  const a = donationAssetOrDefault(asset);
  // Always asked (hooks cannot be conditional); the quote layer serves WETH from the shared base set.
  const { quote } = useQuoteUsd(EXTERNAL_ADDRESSES.weth);
  const ethUsd = quote?.priceUsd ?? null;
  return useMemo(() => {
    if (a === "usdc") return { asset: a, unit: USDC_UNIT, priced: true, symbol: "USDC", ethUsd };
    return { asset: a, unit: { decimals: 18, usd: ethUsd ?? 0 }, priced: ethUsd !== null, symbol: "ETH", ethUsd };
  }, [a, ethUsd]);
}
