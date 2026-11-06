import { EXTERNAL_ADDRESSES, THIN_DEPTH_USD, type DonationAsset } from "@varada/sdk";

/** Plain-language names of the two choices, for the wizard, the review and the token page. */
export const DONATION_ASSET_LABEL: Record<DonationAsset, string> = { usdc: "USDC", eth: "ETH" };

export interface DonationAssetHint {
  /** The asset the pair's liquidity favours; null when the app cannot tell. */
  suggest: DonationAsset | null;
  text: string;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Which donation asset suits a pair, from route depth (the pricing layer's depth of the quote
 * asset's fee route). A WETH pair needs no conversion into ETH and a USDC pair none into USDC; for
 * anything else the deeper route wins. `ethDepthUsd` is the depth of the route to ETH when known
 * (undefined: not read), `usdcDepthUsd` that of the route to USDC.
 */
export function donationAssetHint(quoteAddress: string, depths: { usdcDepthUsd?: number | null; ethDepthUsd?: number | null } = {}): DonationAssetHint {
  const q = quoteAddress.toLowerCase();
  if (q === EXTERNAL_ADDRESSES.weth.toLowerCase()) return { suggest: "eth", text: "Your pair is WETH, so fees reach ETH with no conversion. Choosing USDC adds a WETH to USDC swap on every collection." };
  if (q === EXTERNAL_ADDRESSES.usdc.toLowerCase()) return { suggest: "usdc", text: "Your pair is USDC, so fees reach USDC with no conversion. Choosing ETH adds a USDC to WETH swap on every collection." };
  const u = depths.usdcDepthUsd ?? null;
  const e = depths.ethDepthUsd ?? null;
  if (u !== null && e !== null) {
    const better: DonationAsset = e > u ? "eth" : "usdc";
    return { suggest: better, text: `Route depth to USDC is about ${usd(u)} and to ETH about ${usd(e)}; the deeper route loses less to price impact when fees convert.` };
  }
  if (u !== null && Number.isFinite(u)) {
    return u >= THIN_DEPTH_USD
      ? { suggest: "usdc", text: `This pair has about ${usd(u)} of depth on its route to USDC, enough for USDC. ETH works too if a route to it is configured.` }
      : { suggest: null, text: `The route from this pair to USDC is thin (about ${usd(u)}). If it has a deeper route to ETH, ETH converts with less loss.` };
  }
  return { suggest: null, text: "Route depth for this pair could not be read. Either choice works; pick the asset your charities would rather receive." };
}
