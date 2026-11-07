import { describe, expect, it } from "vitest";
import {
  canAdvance,
  feeErrors,
  firstInvalidStep,
  initialWizardState,
  labelBlockedText,
  labelForName,
  marketCapError,
  pairErrors,
  toLaunchInput,
  validateStep,
  type WizardState,
} from "@/lib/launch-steps";
import {
  DEFAULT_DONATION_THRESHOLD_USDC,
  marketCapFromTick,
  parseLaunchInput,
  parseUsdc,
  priceFromTick,
  ROTATIONS,
  startTickFromMarketCap,
} from "@/lib/launch";

const SALT = `0x${"11".repeat(32)}`;
const CAUSE = `0x${"ab".repeat(32)}`;

function filled(over: Partial<WizardState> = {}): WizardState {
  const s = initialWizardState(SALT);
  return { ...s, input: { ...s.input, name: "Test Coin", symbol: "TEST", label: "test-coin" }, logoRef: "cd".repeat(32), ...over };
}

describe("start tick from market cap", () => {
  it("maps the factory's reference market cap to its reference tick", () => {
    expect(startTickFromMarketCap(10)).toBe(-230_200);
  });
  it("always lands on the tick spacing", () => {
    for (const cap of [0.5, 1, 7, 123, 4_000, 1e6]) {
      const t = startTickFromMarketCap(cap)!;
      expect(Math.abs(t % 200)).toBe(0);
      // one step is 2% of price, so the realised cap is within about 1% of the request
      expect(Math.abs(marketCapFromTick(t) / cap - 1)).toBeLessThan(0.011);
    }
  });
  it("rejects zero, negative, non-finite and out-of-range caps", () => {
    for (const cap of [0, -1, NaN, Infinity, 1e-30, 1e40]) expect(startTickFromMarketCap(cap)).toBeNull();
  });
  it("price is 1.0001^tick", () => {
    expect(priceFromTick(0)).toBe(1);
    expect(marketCapFromTick(-230_200)).toBeCloseTo(10, 0);
  });
});

describe("parseUsdc", () => {
  it("reads plain amounts to 6 decimals", () => {
    expect(parseUsdc("25")).toBe(25_000_000n);
    expect(parseUsdc("0.5")).toBe(500_000n);
    expect(parseUsdc("1.000001")).toBe(1_000_001n);
  });
  it("rejects anything else", () => {
    for (const v of ["", "-1", "1.0000001", "1e3", "abc", "1,5"]) expect(parseUsdc(v)).toBeNull();
  });
});

describe("live parameters", () => {
  const base = { ...toLaunchInput(filled()), mode: "live" as const, initialCause: CAUSE };
  it("encodes the rotation enum, cause and a nonzero threshold", () => {
    const r = parseLaunchInput({ ...base, rotation: "72h", donationThreshold: "100" });
    expect(r.ok && r.live).toEqual({ initialCause: CAUSE, rotationPeriod: 3, donationThreshold: 100_000_000n });
  });
  it("maps the five periods to the contract enum order", () => {
    expect(ROTATIONS.map((r) => [r.key, r.value])).toEqual([["1h", 0], ["12h", 1], ["24h", 2], ["72h", 3], ["week", 4]]);
  });
  it("defaults to a nonzero threshold and refuses zero", () => {
    expect(parseUsdc(DEFAULT_DONATION_THRESHOLD_USDC)! > 0n).toBe(true);
    const r = parseLaunchInput({ ...base, donationThreshold: "0" });
    expect(!r.ok && r.error).toMatch(/above zero/);
  });
  it("caps the threshold and requires a cause and a known rotation", () => {
    expect(parseLaunchInput({ ...base, donationThreshold: "1000001" }).ok).toBe(false);
    expect(parseLaunchInput({ ...base, initialCause: "" }).ok).toBe(false);
    expect(parseLaunchInput({ ...base, initialCause: `0x${"0".repeat(64)}` }).ok).toBe(false);
    expect(parseLaunchInput({ ...base, rotation: "2d" }).ok).toBe(false);
  });
  it("a weekly launch carries no live parameters", () => {
    const r = parseLaunchInput({ ...base, mode: "weekly" });
    expect(r.ok && r.live).toBeUndefined();
  });
});

describe("fee rules match the factory", () => {
  it("needs a decay when there is a surcharge, at most one day", () => {
    const s = filled();
    expect(parseLaunchInput({ ...toLaunchInput(s), sniperFeeStartBps: "3000", sniperDecaySeconds: "0" }).ok).toBe(false);
    expect(parseLaunchInput({ ...toLaunchInput(s), sniperFeeStartBps: "3000", sniperDecaySeconds: "86401" }).ok).toBe(false);
    expect(parseLaunchInput({ ...toLaunchInput(s), sniperFeeStartBps: "3000", sniperDecaySeconds: "86400" }).ok).toBe(true);
    expect(parseLaunchInput({ ...toLaunchInput(s), startTick: "-230201" }).ok).toBe(false);
  });
  it("validates the fee step", () => {
    const s = filled();
    expect(feeErrors(s)).toEqual({});
    expect(feeErrors({ ...s, input: { ...s.input, baseFeeBps: "50" } }).baseFeeBps).toBeTruthy();
    expect(feeErrors({ ...s, input: { ...s.input, sniperFeeStartBps: "8001" } }).sniperFeeStartBps).toBeTruthy();
    expect(feeErrors({ ...s, input: { ...s.input, sniperFeeStartBps: "500", sniperDecaySeconds: "0" } }).sniperDecaySeconds).toBeTruthy();
  });
});

describe("step guards", () => {
  it("blocks identity until name, ticker, label and logo are valid", () => {
    expect(canAdvance("identity", initialWizardState(SALT))).toBe(false);
    expect(canAdvance("identity", filled())).toBe(true);
    expect(validateStep("identity", filled({ logoRef: null })).logo).toBeTruthy();
    expect(canAdvance("identity", filled({ logoRef: null, input: { ...filled().input, metadataURI: "bzz://x" } }))).toBe(true);
    expect(validateStep("identity", filled({ logoUploading: true })).logo).toMatch(/upload/i);
  });
  it("blocks a taken label and a label reserved to someone else", () => {
    expect(validateStep("identity", filled({ labelStatus: { kind: "taken", token: "0x0000000000000000000000000000000000000001" } })).label).toMatch(/taken/);
    const reserved = { kind: "reserved" as const, allowedCreator: "0x00000000000000000000000000000000000000aa" as const };
    expect(validateStep("identity", filled({ labelStatus: reserved })).label).toMatch(/reserved/);
    expect(canAdvance("identity", filled({ labelStatus: reserved, account: reserved.allowedCreator }))).toBe(true);
  });
  it("maps publisher limits to the field", () => {
    const s = filled();
    expect(validateStep("identity", { ...s, fields: { ...s.fields, website: "ftp://x" } }).website).toMatch(/Website/);
    expect(validateStep("identity", { ...s, input: { ...s.input, symbol: "bad symbol" } }).symbol).toMatch(/Symbol/);
  });
  it("live mode needs a charity and an enabled factory", () => {
    const s = filled();
    const live = { ...s, input: { ...s.input, mode: "live" as const } };
    expect(validateStep("mode", live).initialCause).toBeTruthy();
    expect(validateStep("mode", { ...live, input: { ...live.input, initialCause: CAUSE } })).toEqual({});
    expect(validateStep("mode", { ...live, input: { ...live.input, initialCause: CAUSE }, liveReady: false }).mode).toBeTruthy();
    expect(validateStep("mode", s)).toEqual({});
  });
  it("pair needs an allowlisted asset and a market cap in range", () => {
    const s = filled();
    expect(pairErrors({ ...s, allowedQuotes: ["0x0000000000000000000000000000000000000001"] }).quoteAsset).toBeTruthy();
    expect(pairErrors({ ...s, allowedQuotes: [s.input.quoteAsset.toLowerCase()] })).toEqual({});
    expect(marketCapError("")).toBeTruthy();
    expect(marketCapError("0")).toBeTruthy();
    expect(marketCapError("10")).toBeUndefined();
  });
  it("focus needs two eligible entries once the count is known", () => {
    expect(validateStep("focus", filled({ pool: 1 })).focus).toMatch(/at least 2/);
    expect(canAdvance("focus", filled({ pool: 2 }))).toBe(true);
    expect(canAdvance("focus", filled({ pool: null }))).toBe(true);
    expect(canAdvance("focus", filled({ pool: undefined }))).toBe(true);
  });
  it("finds the first invalid step and encodes the whole launch", () => {
    expect(firstInvalidStep(initialWizardState(SALT))).toBe(0);
    const s = filled();
    expect(firstInvalidStep(s)).toBe(-1);
    const r = parseLaunchInput(toLaunchInput(s));
    expect(r.ok && r.params.startTick).toBe(-230_200);
    expect(r.ok && r.params.salt).toBe(SALT);
    expect(r.ok && r.params.logoRef).toBe(`0x${"cd".repeat(32)}`);
  });
});

describe("coin name from the token name", () => {
  it("derives the label from the name and blocks a stale, invalid or reserved one", () => {
    expect(labelForName("Harambe Relief Fund")).toBe("harambe-relief-fund");
    expect(labelForName("!!")).toBe("");
    expect(canAdvance("identity", filled())).toBe(true);
    // A label that doesn't follow the name (an old draft, a hand edit) never launches.
    expect(validateStep("identity", filled({ input: { ...filled().input, label: "something-else" } })).label).toMatch(/follow the token name/);
    // A name that gives no valid label.
    expect(validateStep("identity", filled({ input: { ...filled().input, name: "!!", label: "" } })).label).toMatch(/can't become an ENS name/);
    // Reserved namespaces are blocked client-side, even with no registry read.
    for (const name of ["Org", "Coin", "Donor", "Agent", "Names", "Endaoment", "Varada"]) {
      const st = filled({ input: { ...filled().input, name, label: name.toLowerCase() } });
      expect(validateStep("identity", st).label).toMatch(/is reserved/);
      expect(canAdvance("identity", st)).toBe(false);
    }
  });

  it("names the coin name and the holder when taken", () => {
    const t = labelBlockedText("paws", { kind: "taken", token: "0x00000000000000000000000000000000000000a1" });
    expect(t).toBe("paws.coin.varada.eth is already taken by 0x0000…00a1. Choose a different token name.");
    expect(canAdvance("identity", filled({ labelStatus: { kind: "taken", token: "0x0000000000000000000000000000000000000001" } }))).toBe(false);
  });
});

describe("labelBlockedText", () => {
  const reserved = { kind: "reserved" as const, allowedCreator: "0x00000000000000000000000000000000000000aa" as const };
  it("blocks taken labels and labels reserved to another wallet, nothing else", () => {
    expect(labelBlockedText("paws", { kind: "taken", token: "0x0000000000000000000000000000000000000001" })).toMatch(/taken/);
    expect(labelBlockedText("paws", reserved, "0x00000000000000000000000000000000000000bb")).toMatch(/reserved/);
    expect(labelBlockedText("paws", reserved, reserved.allowedCreator.toUpperCase().replace("0X", "0x"))).toBeUndefined();
    expect(labelBlockedText("paws", { kind: "available" })).toBeUndefined();
    expect(labelBlockedText("paws", { kind: "unknown", reason: "profileRegistryAddress is not configured" })).toBeUndefined();
  });
});
