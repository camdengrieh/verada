import { describe, expect, it } from "vitest";
import { describeFee, readVaradaFee, splitFee, sniperEndsAt, surchargeBpsAt, detectMode } from "../../src/index.js";
import { HOOK, TOKEN } from "./helpers.js";

const cfg = { baseFeeBps: 200, surchargeStartBps: 4000, decaySeconds: 3600, launchTimestamp: 1_000_000 };

describe("surcharge schedule", () => {
  it("starts at the launch surcharge, decays linearly (rounded up) and ends at zero", () => {
    expect(surchargeBpsAt(cfg, 999_000)).toBe(4000);
    expect(surchargeBpsAt(cfg, 1_000_000)).toBe(4000);
    expect(surchargeBpsAt(cfg, 1_001_800)).toBe(2000);
    expect(surchargeBpsAt(cfg, 1_000_001)).toBe(3999); // 4000 * 3599 / 3600 = 3998.9 rounds up
    expect(surchargeBpsAt(cfg, 1_003_600)).toBe(0);
    expect(surchargeBpsAt(cfg, 9_000_000)).toBe(0);
  });
  it("is zero without a surcharge", () => {
    expect(surchargeBpsAt({ ...cfg, surchargeStartBps: 0 }, 1_000_000)).toBe(0);
    expect(sniperEndsAt({ ...cfg, surchargeStartBps: 0 })).toBeNull();
    expect(sniperEndsAt(cfg)).toBe(1_003_600);
  });
});

describe("fee info", () => {
  it("splits the fee 90 / 10 and reports the sniper state", () => {
    const f = describeFee("weekly", cfg, 2600);
    expect(f).toMatchObject({ feeBps: 2600, baseFeeBps: 200, sniperBps: 2400, sniperActive: true, sniperEndsAt: 1_003_600, causeShareBps: 9000, platformShareBps: 1000 });
    expect(describeFee("live", cfg, 200).sniperActive).toBe(false);
  });
  it("splits amounts with the platform share rounded down", () => {
    expect(splitFee(1000n)).toEqual({ platform: 100n, cause: 900n });
    expect(splitFee(19n)).toEqual({ platform: 1n, cause: 18n });
  });
  it("reads the fee from a hook and detects live hooks by their vault", async () => {
    const mk = (live: boolean) => ({
      readContract: async (a: { functionName: string }) => {
        if (a.functionName === "currentFeeBps") return 2600;
        if (a.functionName === "feeConfig") return { baseFeeBps: 200, surchargeStartBps: 4000, decaySeconds: 3600, launchTimestamp: 1_000_000 };
        if (a.functionName === "vault") {
          if (live) return HOOK;
          throw new Error("execution reverted");
        }
        throw new Error("unexpected " + a.functionName);
      },
    });
    expect((await readVaradaFee(mk(true) as never, TOKEN, HOOK)).mode).toBe("live");
    expect((await readVaradaFee(mk(false) as never, TOKEN, HOOK)).mode).toBe("weekly");
    expect(await detectMode(mk(true) as never, HOOK)).toBe("live");
    expect((await readVaradaFee(mk(false) as never, TOKEN, HOOK, { mode: "live" })).mode).toBe("live");
  });
  it("turns a hook read failure into a typed error", async () => {
    const client = { readContract: async () => { throw new Error("boom"); } };
    await expect(readVaradaFee(client as never, TOKEN, HOOK)).rejects.toMatchObject({ reason: "hook-reverted" });
  });
});
