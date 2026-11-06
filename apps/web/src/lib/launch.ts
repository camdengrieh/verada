import { getAddress, isAddress, isHex, toHex, type Address, type Hex } from "viem";
import {
  ALL_CATEGORIES_MASK,
  ALL_REGIONS_MASK,
  categoryMaskOf,
  DEFAULT_DONATION_ASSET,
  DONATION_ASSET_ENUM,
  EXTERNAL_ADDRESSES,
  parseDonationAmount,
  type DonationAsset,
  isValidLabel,
  normalizeSwarmReference,
  regionMaskOf,
  swarmReferenceToBytes32,
} from "@varada/sdk";
import type { TokenMetadataDocument } from "./publisher";

// Fee bounds mirror the contract constants MIN_FEE_BPS / MAX_FEE_BPS.
export const MIN_FEE_BPS = 100;
export const MAX_FEE_BPS = 500;

/** The fixed supply of every Varada coin, in whole tokens (`VaradaToken.INITIAL_SUPPLY`). */
export const TOKEN_SUPPLY = 100_000_000_000;
/** `VaradaFactory.TICK_SPACING`: `startTick` must be a multiple of it. */
export const TICK_SPACING = 200;
/** Whole-token start ticks the app offers (the factory's fuzz range; 400,000 reverts with `LiquidityTooLarge`). */
export const MIN_START_TICK = -400_000;
export const MAX_START_TICK = 240_000;
/** Highest sniper surcharge start and longest decay the factory accepts. */
export const MAX_SNIPER_START_BPS = 8000;
export const MAX_SNIPER_DECAY_SECONDS = 86_400;
/** `LiveDonationVault.MAX_DONATION_THRESHOLD` in USDC (6 decimals). */
export const MAX_DONATION_THRESHOLD_USDC = 1_000_000;
/** Default live-donation threshold in USDC. Zero pushes a donation on every swap (~105-150k extra gas each). */
export const DEFAULT_DONATION_THRESHOLD_USDC = "25";
/**
 * Live-donation thresholds are written in the token's donation asset. The ETH numbers mirror the
 * USDC ones at roughly 2,500 USD per ETH (the contract's own cap decides; a launch above it reverts).
 */
export const DEFAULT_DONATION_THRESHOLD: Record<DonationAsset, string> = { usdc: DEFAULT_DONATION_THRESHOLD_USDC, eth: "0.01" };
export const DONATION_THRESHOLD_PRESETS: Record<DonationAsset, readonly string[]> = { usdc: ["10", "25", "100", "500"], eth: ["0.005", "0.01", "0.05", "0.25"] };
export const MAX_DONATION_THRESHOLD: Record<DonationAsset, number> = { usdc: MAX_DONATION_THRESHOLD_USDC, eth: 400 };

export type GivingModeKey = "weekly" | "live";

/** Rotation periods of a live coin, in the order of `RotationPeriod` in the contracts. */
export const ROTATIONS = [
  { key: "1h", value: 0, seconds: 3_600, label: "Every hour" },
  { key: "12h", value: 1, seconds: 43_200, label: "Every 12 hours" },
  { key: "24h", value: 2, seconds: 86_400, label: "Every day" },
  { key: "72h", value: 3, seconds: 259_200, label: "Every 3 days" },
  { key: "week", value: 4, seconds: 604_800, label: "Every week" },
] as const;
export type RotationKey = (typeof ROTATIONS)[number]["key"];
export const DEFAULT_ROTATION: RotationKey = "24h";

export const rotationOf = (key: string) => ROTATIONS.find((r) => r.key === key);

/** USDC decimal text ("25", "0.5") to base units (6 decimals); null when not a plain amount with at most 6 decimals. */
export function parseUsdc(value: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** Price in quote per whole token at a whole-token tick: 1.0001^tick. */
export const priceFromTick = (tick: number): number => Math.pow(1.0001, tick);
/** Start market cap in quote units at a tick (fixed supply times price). */
export const marketCapFromTick = (tick: number): number => priceFromTick(tick) * TOKEN_SUPPLY;

/**
 * The factory's start tick for a market cap in quote units: the nearest multiple of the tick
 * spacing to ln(price)/ln(1.0001), where price is market cap over the fixed supply. Null for a
 * non-positive or non-finite cap or one outside the tick range the app offers.
 */
export function startTickFromMarketCap(marketCap: number): number | null {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return null;
  const raw = Math.log(marketCap / TOKEN_SUPPLY) / Math.log(1.0001);
  const tick = Math.round(raw / TICK_SPACING) * TICK_SPACING;
  if (!Number.isFinite(tick) || tick < MIN_START_TICK || tick > MAX_START_TICK) return null;
  return tick === 0 ? 0 : tick;
}

export interface LaunchInput {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: string;
  baseFeeBps: string;
  sniperFeeStartBps: string;
  sniperDecaySeconds: string;
  startTick: string;
  /** Quote asset address; must be allowlisted in the on-chain quote registry. */
  quoteAsset: string;
  /** ENS label: the token's name becomes `<label>.<parent>`. */
  label: string;
  /** Swarm reference of the uploaded logo (64 hex, `0x` or `bzz://` optional); empty for none. */
  logoRef: string;
  /** Cause focus, fixed forever: category and region slugs (empty: any). */
  categories: string[];
  regions: string[];
  /** Giving mode; weekly pool when omitted. */
  mode?: GivingModeKey;
  /** Live mode: rotation period key. */
  rotation?: string;
  /** Live mode: donation threshold in the donation asset (USDC or ETH), decimal text. */
  donationThreshold?: string;
  /** Asset fees are consolidated into and donated in; USDC when omitted. */
  donationAsset?: DonationAsset;
  /** Live mode: cause id of the first charity; must be active in the cause registry. */
  initialCause?: string;
}

/** `VaradaFactory.LiveParams`. */
export interface LiveParams {
  initialCause: Hex;
  rotationPeriod: number;
  donationThreshold: bigint;
}

export interface DeployParams {
  name: string;
  symbol: string;
  metadataURI: string;
  salt: Hex;
  baseFeeBps: number;
  sniperFeeStartBps: number;
  sniperDecaySeconds: number;
  startTick: number;
  quoteAsset: Address;
  label: string;
  logoRef: Hex;
  categoryMask: bigint;
  regionMask: number;
  /** `enum DonationAsset { Usdc, Eth }`: 0 USDC, 1 ETH (WETH on chain). */
  donationAsset: 0 | 1;
}

export const ZERO_LOGO_REF: Hex = `0x${"0".repeat(64)}`;

export type ParseResult = { ok: true; params: DeployParams; live?: LiveParams } | { ok: false; error: string };

function int(value: string, label: string, min: number, max: number): number | string {
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n)) return `${label} must be an integer`;
  if (n < min || n > max) return `${label} must be between ${min} and ${max}`;
  return n;
}

export function parseLaunchInput(input: LaunchInput): ParseResult {
  if (!input.name.trim()) return { ok: false, error: "Name is required" };
  if (!input.symbol.trim()) return { ok: false, error: "Symbol is required" };
  const label = input.label.trim();
  if (!isValidLabel(label)) {
    return { ok: false, error: "Label must be 3 to 63 characters of a-z, 0-9 and hyphens, not starting or ending with a hyphen" };
  }
  let logoRef = ZERO_LOGO_REF;
  if (input.logoRef.trim() !== "") {
    try {
      logoRef = swarmReferenceToBytes32(input.logoRef);
    } catch (e) {
      return { ok: false, error: `Logo reference: ${e instanceof Error ? e.message : "invalid"}` };
    }
  }

  const baseFeeBps = int(input.baseFeeBps, "Base fee (bps)", MIN_FEE_BPS, MAX_FEE_BPS);
  if (typeof baseFeeBps === "string") return { ok: false, error: baseFeeBps };
  // Anti-sniper surcharge starts at most 80% (8000 bps).
  const sniperFeeStartBps = int(input.sniperFeeStartBps, "Sniper fee start (bps)", 0, MAX_SNIPER_START_BPS);
  if (typeof sniperFeeStartBps === "string") return { ok: false, error: sniperFeeStartBps };
  // The factory rejects a surcharge without a decay of 1 second to 1 day.
  const sniperDecaySeconds = int(input.sniperDecaySeconds, "Sniper decay (seconds)", sniperFeeStartBps === 0 ? 0 : 1, MAX_SNIPER_DECAY_SECONDS);
  if (typeof sniperDecaySeconds === "string") return { ok: false, error: sniperDecaySeconds };
  const startTick = int(input.startTick, "Start tick", -887272, 887272);
  if (typeof startTick === "string") return { ok: false, error: startTick };
  if (startTick % TICK_SPACING !== 0) return { ok: false, error: `Start tick must be a multiple of ${TICK_SPACING}` };

  const quote = input.quoteAsset.trim() === "" ? EXTERNAL_ADDRESSES.weth : input.quoteAsset.trim();
  if (!isAddress(quote, { strict: false })) return { ok: false, error: "Quote asset must be an address" };

  let categoryMask: bigint;
  let regionMask: number;
  try {
    categoryMask = input.categories.length ? categoryMaskOf(input.categories) : ALL_CATEGORIES_MASK;
    regionMask = input.regions.length ? regionMaskOf(input.regions) : ALL_REGIONS_MASK;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid cause focus" };
  }

  const salt = input.salt.trim();
  if (salt !== "" && !(isHex(salt) && salt.length === 66)) {
    return { ok: false, error: "Salt must be empty or a 32-byte hex string" };
  }

  const asset: DonationAsset = input.donationAsset ?? DEFAULT_DONATION_ASSET;
  if (asset !== "usdc" && asset !== "eth") return { ok: false, error: "Donation asset must be USDC or ETH" };

  let live: LiveParams | undefined;
  if (input.mode === "live") {
    const rotation = rotationOf(input.rotation ?? DEFAULT_ROTATION);
    if (!rotation) return { ok: false, error: "Pick how often the charity rotates" };
    const cause = (input.initialCause ?? "").trim();
    if (!isHex(cause) || cause.length !== 66 || /^0x0{64}$/.test(cause)) return { ok: false, error: "Pick the charity that receives the first rotation" };
    const sym = asset === "eth" ? "ETH" : "USDC";
    const amount = parseDonationAmount(input.donationThreshold ?? DEFAULT_DONATION_THRESHOLD[asset], asset);
    if (amount === null) return { ok: false, error: `Donation threshold must be a ${sym} amount with at most ${asset === "eth" ? 18 : 6} decimals` };
    if (amount === 0n) return { ok: false, error: "Donation threshold must be above zero: a zero threshold donates on every swap and adds about 105,000 to 150,000 gas to each" };
    if (amount > BigInt(MAX_DONATION_THRESHOLD[asset]) * 10n ** BigInt(asset === "eth" ? 18 : 6)) return { ok: false, error: `Donation threshold can be at most ${MAX_DONATION_THRESHOLD[asset].toLocaleString("en-US")} ${sym}` };
    live = { initialCause: cause as Hex, rotationPeriod: rotation.value, donationThreshold: amount };
  }

  return {
    ok: true,
    live,
    params: {
      name: input.name.trim(),
      symbol: input.symbol.trim(),
      metadataURI: input.metadataURI.trim(),
      salt: salt === "" ? randomSalt() : (salt as Hex),
      baseFeeBps,
      sniperFeeStartBps,
      sniperDecaySeconds,
      startTick,
      quoteAsset: getAddress(quote.toLowerCase()),
      label,
      logoRef,
      categoryMask,
      regionMask,
      donationAsset: DONATION_ASSET_ENUM[asset],
    },
  };
}

/** Optional profile fields that go into the metadata document. */
export interface MetadataFields {
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

export const EMPTY_METADATA_FIELDS: MetadataFields = { description: "", website: "", twitter: "", telegram: "", discord: "" };

export type MetadataResult = { ok: true; doc: TokenMetadataDocument } | { ok: false; error: string };

const HANDLE = /^[^\s"'`]{1,64}$/;

/**
 * Builds the publisher's `TokenMetadata` document, applying the publisher's rules so the user sees
 * errors before uploading. The document never carries a wallet address.
 */
export function buildMetadataDocument(
  token: { name: string; symbol: string },
  logoRef: string,
  fields: MetadataFields,
): MetadataResult {
  const name = token.name.trim();
  const symbol = token.symbol.trim();
  if (name.length < 1 || name.length > 64) return { ok: false, error: "Name must be 1 to 64 characters" };
  if (!/^[A-Za-z0-9$._-]{1,16}$/.test(symbol)) return { ok: false, error: "Symbol must be 1 to 16 letters, digits or $._-" };
  let ref: string;
  try {
    ref = normalizeSwarmReference(logoRef);
  } catch {
    return { ok: false, error: "Upload a logo first (metadata needs its Swarm reference)" };
  }
  const doc: TokenMetadataDocument = { name, symbol, logoRef: ref };
  const description = fields.description.trim();
  if (description) {
    if (description.length > 2000) return { ok: false, error: "Description must be at most 2000 characters" };
    doc.description = description;
  }
  const website = fields.website.trim();
  if (website) {
    if (website.length > 256 || !/^https?:\/\/[^\s]+$/i.test(website)) return { ok: false, error: "Website must be an http(s) URL of at most 256 characters" };
    try {
      new URL(website);
    } catch {
      return { ok: false, error: "Website must be a valid URL" };
    }
    doc.website = website;
  }
  for (const key of ["twitter", "telegram"] as const) {
    const v = fields[key].trim().replace(/^@/, "");
    if (!v) continue;
    if (!HANDLE.test(v)) return { ok: false, error: `${key === "twitter" ? "Twitter" : "Telegram"} must be at most 64 characters with no spaces or quotes` };
    doc[key] = v;
  }
  const discord = fields.discord.trim();
  if (discord) {
    if (discord.length > 256) return { ok: false, error: "Discord must be at most 256 characters" };
    doc.discord = discord;
  }
  return { ok: true, doc };
}

export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
