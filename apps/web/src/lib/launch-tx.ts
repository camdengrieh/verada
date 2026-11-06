import type { Address } from "viem";
import { factoryAbi } from "./abis";
import type { DeployParams, LiveParams } from "./launch";

/** Placeholder metadata URI of the right shape, used only to estimate gas before the real upload. */
export const ESTIMATE_METADATA_URI = `bzz://${"0".repeat(64)}`;

export interface LiveCallParams {
  initialCause: `0x${string}`;
  rotationPeriod: number;
  donationThreshold: bigint;
}

export type LaunchCall =
  | { address: Address; abi: typeof factoryAbi; functionName: "deployToken"; args: readonly [DeployParams] }
  | { address: Address; abi: typeof factoryAbi; functionName: "deployLiveToken"; args: readonly [DeployParams, LiveCallParams] };

/** The factory call for a parsed launch: `deployLiveToken` when live parameters exist, else `deployToken`. */
export function launchCall(factory: Address, params: DeployParams, metadataURI: string, live?: LiveParams): LaunchCall {
  const p = { ...params, metadataURI };
  if (live) {
    return {
      address: factory,
      abi: factoryAbi,
      functionName: "deployLiveToken",
      args: [p, { initialCause: live.initialCause, rotationPeriod: live.rotationPeriod, donationThreshold: live.donationThreshold }],
    };
  }
  return { address: factory, abi: factoryAbi, functionName: "deployToken", args: [p] };
}

/** Share text and links for a launched coin. */
export function shareLinks(opts: { name: string; symbol: string; pageUrl: string }) {
  const text = `${opts.name} ($${opts.symbol}) just launched on Varada: every trade gives to charity.`;
  const enc = encodeURIComponent;
  return {
    text,
    x: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(opts.pageUrl)}`,
    telegram: `https://t.me/share/url?url=${enc(opts.pageUrl)}&text=${enc(text)}`,
  };
}
