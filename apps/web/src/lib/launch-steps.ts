import { ENS_PARENT_NAME, EXTERNAL_ADDRESSES, coinParentName, isReservedLabel, isValidLabel, labelFromName } from "@varada/sdk";
import type { LabelStatus } from "./chain-reads";
import {
  buildMetadataDocument,
  DEFAULT_DONATION_THRESHOLD,
  DEFAULT_ROTATION,
  EMPTY_METADATA_FIELDS,
  MAX_FEE_BPS,
  MAX_SNIPER_DECAY_SECONDS,
  MAX_SNIPER_START_BPS,
  MIN_FEE_BPS,
  parseLaunchInput,
  startTickFromMarketCap,
  type LaunchInput,
  type MetadataFields,
} from "./launch";

/** The wizard's steps in order. */
export const STEPS = [
  { id: "identity", label: "Identity", description: "Name, ticker, ENS name and logo" },
  { id: "mode", label: "Giving", description: "Epoch pool or live donation" },
  { id: "pair", label: "Pair", description: "What your coin trades against" },
  { id: "focus", label: "Causes", description: "Which charities can receive fees" },
  { id: "fees", label: "Fees", description: "Trading fee and launch protection" },
  { id: "review", label: "Review", description: "Check everything, then sign" },
] as const;
export type StepId = (typeof STEPS)[number]["id"];

/** Market cap, in units of the quote asset, a new coin starts at (-230,200 ticks: the factory's reference launch). */
export const DEFAULT_MARKET_CAP = "10";

export interface WizardState {
  input: LaunchInput;
  fields: MetadataFields;
  /** Swarm reference of the uploaded logo, if any. */
  logoRef: string | null;
  /** True while a logo upload is running. */
  logoUploading: boolean;
  /** Start market cap in quote units, as typed. */
  marketCap: string;
  /** Registry state of the label; undefined while unknown (loading, or the read failed). */
  labelStatus?: LabelStatus;
  /** The connected wallet, for a label reserved to it. */
  account?: string;
  /** Eligible catalogue entries for the focus; undefined while loading, null when the catalogue is unavailable. */
  pool?: number | null;
  /** The quote registry's active assets (addresses); undefined while loading. */
  allowedQuotes?: readonly string[];
  /** Whether the factory has live-donation mode configured; undefined while unknown. */
  liveReady?: boolean;
  /** Whether the chosen first charity is active in the cause registry; undefined while unknown. */
  causeActive?: boolean;
  /** ENS parent (config.ensParentName) for coin-name messages; defaults to varada.eth. */
  ensParentName?: string;
}

export function initialWizardState(salt: string): WizardState {
  return {
    input: {
      name: "",
      symbol: "",
      label: "",
      logoRef: "",
      metadataURI: "",
      salt,
      baseFeeBps: String(MIN_FEE_BPS * 3),
      sniperFeeStartBps: "0",
      sniperDecaySeconds: "0",
      startTick: String(startTickFromMarketCap(Number(DEFAULT_MARKET_CAP)) ?? 0),
      quoteAsset: EXTERNAL_ADDRESSES.weth,
      categories: [],
      regions: [],
      mode: "weekly",
      rotation: DEFAULT_ROTATION,
      donationThreshold: DEFAULT_DONATION_THRESHOLD.usdc,
      donationAsset: "usdc",
      initialCause: "",
    },
    fields: EMPTY_METADATA_FIELDS,
    logoRef: null,
    logoUploading: false,
    marketCap: DEFAULT_MARKET_CAP,
  };
}

/**
 * The coin's ENS label: always derived from the token name (never typed), so a name can only be
 * launched once and a copycat can't register a look-alike. Empty when the name gives no valid label.
 */
export const labelForName = (name: string): string => labelFromName(name) ?? "";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export type StepErrors = Partial<Record<string, string>>;

const sameAddress = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const PROFILE_FIELD = [
  ["Name", "name"],
  ["Symbol", "symbol"],
  ["Description", "description"],
  ["Website", "website"],
  ["Twitter", "twitter"],
  ["Telegram", "telegram"],
  ["Discord", "discord"],
] as const;

/**
 * Why a registry status stops the launch: taken, or reserved for another wallet. Undefined when it
 * does not. `parent` is the ENS parent; the message shows the coin name `<label>.coin.<parent>`.
 */
export function labelBlockedText(label: string, status: LabelStatus, account?: string, parent: string = ENS_PARENT_NAME): string | undefined {
  const name = `${label}.${coinParentName(parent)}`;
  if (status.kind === "taken") return `${name} is already taken by ${short(status.token)}. Choose a different token name.`;
  if (status.kind === "reserved" && !sameAddress(status.allowedCreator, account)) return `${name} is reserved. Choose a different token name.`;
  return undefined;
}

/** Whether the registry reserves `label` for the connected wallet (the one case a reserved label is usable). */
const reservedForAccount = (status: LabelStatus | undefined, account?: string) =>
  status?.kind === "reserved" && sameAddress(status.allowedCreator, account);

/** Field errors of the identity step, from the publisher's own rules (one message per field). */
export function identityErrors(state: WizardState): StepErrors {
  const errors: StepErrors = {};
  const { input, fields } = state;
  const doc = buildMetadataDocument({ name: input.name, symbol: input.symbol }, "ab".repeat(32), fields);
  if (!doc.ok) {
    const hit = PROFILE_FIELD.find(([prefix]) => doc.error.startsWith(prefix));
    errors[hit?.[1] ?? "name"] = doc.error;
  }
  if (!input.name.trim() && !errors.name) errors.name = "Name is required";
  if (!input.symbol.trim() && !errors.symbol) errors.symbol = "Ticker is required";
  // The label is the token name's slug; a stale or hand-edited label (an old draft) never launches.
  const label = input.label.trim();
  const derived = labelForName(input.name);
  if (!derived) {
    if (input.name.trim() && !errors.name) errors.label = "This token name can't become an ENS name: use at least 3 letters or numbers";
    else errors.label = "The ENS name comes from the token name";
  } else if (label !== derived || !isValidLabel(label)) {
    errors.label = "The ENS name must follow the token name";
  } else if (isReservedLabel(label) && !reservedForAccount(state.labelStatus, state.account)) {
    errors.label = `${label}.${coinParentName(state.ensParentName ?? ENS_PARENT_NAME)} is reserved. Choose a different token name.`;
  } else {
    const blocked = state.labelStatus ? labelBlockedText(label, state.labelStatus, state.account, state.ensParentName ?? ENS_PARENT_NAME) : undefined;
    if (blocked) errors.label = blocked;
  }
  if (state.logoUploading) errors.logo = "Wait for the logo upload to finish";
  else if (!state.logoRef && !input.metadataURI.trim()) errors.logo = "Upload a logo (or set a metadata URI under Advanced)";
  return errors;
}

export function modeErrors(state: WizardState): StepErrors {
  const errors: StepErrors = {};
  if (state.input.mode !== "live") return errors;
  const parsed = parseLaunchInput({ ...state.input, name: "x", symbol: "x", label: "abc", startTick: "0", baseFeeBps: "100", sniperFeeStartBps: "0", sniperDecaySeconds: "0" });
  if (!parsed.ok) {
    const e = parsed.error;
    if (e.startsWith("Pick how often")) errors.rotation = e;
    else if (e.startsWith("Pick the charity")) errors.initialCause = e;
    else if (e.startsWith("Donation threshold")) errors.donationThreshold = e;
  }
  if (state.liveReady === false) errors.mode = "Live donation is not enabled on this factory";
  if (state.causeActive === false && !errors.initialCause) errors.initialCause = "That charity is not active yet; pick one from the list";
  return errors;
}

/** Market cap in quote units for the start tick, or an error text. */
export function marketCapError(text: string): string | undefined {
  const n = Number(text);
  if (text.trim() === "" || !Number.isFinite(n) || n <= 0) return "Enter a market cap above zero";
  if (startTickFromMarketCap(n) === null) return "That market cap is outside the range the factory supports";
  return undefined;
}

export function pairErrors(state: WizardState): StepErrors {
  const errors: StepErrors = {};
  const quote = state.input.quoteAsset.trim().toLowerCase();
  if (!quote) errors.quoteAsset = "Pick a quote asset";
  else if (state.allowedQuotes && !state.allowedQuotes.some((a) => a.toLowerCase() === quote)) errors.quoteAsset = "That asset is not on the quote registry's allowlist";
  const mc = marketCapError(state.marketCap);
  if (mc) errors.marketCap = mc;
  return errors;
}

/** The factory needs two eligible catalogue entries in the focus (`MIN_OPTIONS`). */
export const MIN_FOCUS_POOL = 2;

export function focusErrors(state: WizardState): StepErrors {
  const errors: StepErrors = {};
  if (typeof state.pool === "number" && state.pool < MIN_FOCUS_POOL) {
    errors.focus = `Only ${state.pool} eligible ${state.pool === 1 ? "entry" : "entries"}: a launch needs at least ${MIN_FOCUS_POOL}. Widen the causes or regions.`;
  }
  return errors;
}

export function feeErrors(state: WizardState): StepErrors {
  const errors: StepErrors = {};
  const base = Number(state.input.baseFeeBps);
  if (!Number.isInteger(base) || base < MIN_FEE_BPS || base > MAX_FEE_BPS) errors.baseFeeBps = `Trading fee must be ${MIN_FEE_BPS / 100}% to ${MAX_FEE_BPS / 100}%`;
  const start = Number(state.input.sniperFeeStartBps);
  const decay = Number(state.input.sniperDecaySeconds);
  if (!Number.isInteger(start) || start < 0 || start > MAX_SNIPER_START_BPS) errors.sniperFeeStartBps = `Launch surcharge can be at most ${MAX_SNIPER_START_BPS / 100}%`;
  else if (start > 0 && (!Number.isInteger(decay) || decay < 1 || decay > MAX_SNIPER_DECAY_SECONDS)) errors.sniperDecaySeconds = "The surcharge needs a decay of 1 second to 24 hours";
  return errors;
}

/** The input as the encoder takes it: logo reference and the start tick derived from the market cap. */
export function toLaunchInput(state: WizardState): LaunchInput {
  const tick = startTickFromMarketCap(Number(state.marketCap));
  return { ...state.input, logoRef: state.logoRef ?? "", startTick: String(tick ?? state.input.startTick) };
}

export function validateStep(id: StepId, state: WizardState): StepErrors {
  switch (id) {
    case "identity":
      return identityErrors(state);
    case "mode":
      return modeErrors(state);
    case "pair":
      return pairErrors(state);
    case "focus":
      return focusErrors(state);
    case "fees":
      return feeErrors(state);
    case "review": {
      const parsed = parseLaunchInput(toLaunchInput(state));
      return parsed.ok ? {} : { review: parsed.error };
    }
  }
}

export const canAdvance = (id: StepId, state: WizardState): boolean => Object.keys(validateStep(id, state)).length === 0;

/** Index of the first step with errors, or -1 when the whole launch is valid. */
export function firstInvalidStep(state: WizardState): number {
  return STEPS.findIndex((s) => !canAdvance(s.id, state));
}

/** True when every category is allowed (nothing ticked, or everything ticked). */
export function focusIsAny(categories: readonly string[], regions: readonly string[]): boolean {
  return categories.length === 0 && regions.length === 0;
}
