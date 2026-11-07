import { getAddress, type Address } from "viem";
import { EXTERNAL_ADDRESSES } from "./addresses.js";

/**
 * The asset a token's fees are consolidated into and donated in, chosen at launch and fixed
 * forever. `eth` is WETH on chain.
 */
export type DonationAsset = "usdc" | "eth";

export const DONATION_ASSETS: readonly DonationAsset[] = ["usdc", "eth"] as const;
export const DEFAULT_DONATION_ASSET: DonationAsset = "usdc";

/** `enum DonationAsset { Usdc, Eth }` in the contracts. */
export const DONATION_ASSET_ENUM: Record<DonationAsset, 0 | 1> = { usdc: 0, eth: 1 };

export interface DonationAssetInfo {
  key: DonationAsset;
  /** Symbol shown to people. */
  symbol: "USDC" | "ETH";
  decimals: number;
  /** The ERC-20 the ledgers are held in (USDC, or WETH for ETH). */
  token: Address;
}

const INFO: Record<DonationAsset, DonationAssetInfo> = {
  usdc: { key: "usdc", symbol: "USDC", decimals: 6, token: EXTERNAL_ADDRESSES.usdc },
  eth: { key: "eth", symbol: "ETH", decimals: 18, token: EXTERNAL_ADDRESSES.weth },
};

export const donationAssetInfo = (asset: DonationAsset): DonationAssetInfo => INFO[asset];

/** Contract enum value (or a stored/serialised form) to a {@link DonationAsset}; null if unknown. */
export function parseDonationAsset(value: unknown): DonationAsset | null {
  if (value === "usdc" || value === 0 || value === 0n || value === "0") return "usdc";
  if (value === "eth" || value === 1 || value === 1n || value === "1") return "eth";
  return null;
}

/** Like {@link parseDonationAsset} but unknown values (old rows, missing field) mean USDC, the pre-choice behaviour. */
export const donationAssetOrDefault = (value: unknown): DonationAsset => parseDonationAsset(value) ?? "usdc";

/** Minimal factory read ABI for the per-token donation asset. */
export const donationAssetReadAbi = [
  { type: "function", name: "donationAssetOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint8" }] },
] as const;

export interface DonationAssetReader {
  readContract(args: { address: Address; abi: typeof donationAssetReadAbi; functionName: "donationAssetOf"; args: readonly [Address] }): Promise<unknown>;
}

/** The donation asset of a token (`VaradaFactory.donationAssetOf`). */
export async function readDonationAssetOf(client: DonationAssetReader, factory: Address, token: Address): Promise<DonationAsset> {
  const v = await client.readContract({ address: getAddress(factory), abi: donationAssetReadAbi, functionName: "donationAssetOf", args: [getAddress(token)] });
  return donationAssetOrDefault(v);
}

/** Base units of the donation asset to a plain number of whole units (display only). */
export function donationUnits(amount: bigint | string, asset: DonationAsset): number {
  const a = typeof amount === "bigint" ? amount : BigInt(amount || "0");
  const d = 10n ** BigInt(INFO[asset].decimals);
  return Number(a / d) + Number(a % d) / Number(d);
}

/** Base units of the donation asset to US dollars; `ethUsd` is ignored for USDC. Null when ETH needs a price that is not known. */
export function donationToUsd(amount: bigint | string, asset: DonationAsset, ethUsd: number | null | undefined): number | null {
  const units = donationUnits(amount, asset);
  if (asset === "usdc") return units;
  return typeof ethUsd === "number" && Number.isFinite(ethUsd) && ethUsd > 0 ? units * ethUsd : null;
}

/** Decimal text of base units with trailing zeros trimmed ("1.5"). */
export function formatDonationAmount(amount: bigint, asset: DonationAsset): string {
  if (amount < 0n) throw new RangeError("amount must be non-negative");
  const { decimals } = INFO[asset];
  const unit = 10n ** BigInt(decimals);
  const frac = (amount % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${amount / unit}.${frac}` : (amount / unit).toString();
}

/** Parses typed decimal text into base units of the donation asset; null if malformed or too precise. */
export function parseDonationAmount(value: string, asset: DonationAsset): bigint | null {
  const { decimals } = INFO[asset];
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(value.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** "12.5 USDC" / "0.004 ETH". */
export const donationAmountText = (amount: bigint, asset: DonationAsset): string => `${formatDonationAmount(amount, asset)} ${INFO[asset].symbol}`;
