import type { Address } from "viem";
import { varadaHookFeeAbi } from "./abis.js";
import { CAUSE_FEE_SHARE_BPS, PLATFORM_FEE_SHARE_BPS } from "./constants.js";
import { SwapError } from "./errors.js";
import type { ReadClient } from "./pool.js";
import type { VaradaFeeInfo, VaradaMode } from "./types.js";

export interface HookFeeConfig {
  baseFeeBps: number;
  surchargeStartBps: number;
  decaySeconds: number;
  launchTimestamp: number;
}

/**
 * The anti-sniper surcharge at `nowSec`: `surchargeStartBps` falling linearly to zero over
 * `decaySeconds` from launch, rounded up. Mirrors `LinearDecay.value` / `FeeScheduleLib.surchargeBps`
 * so the UI can count down between reads; the contract stays the source of truth on chain.
 */
export function surchargeBpsAt(cfg: HookFeeConfig, nowSec: number): number {
  const start = BigInt(cfg.surchargeStartBps);
  if (start === 0n) return 0;
  const duration = BigInt(cfg.decaySeconds);
  const launch = BigInt(cfg.launchTimestamp);
  const now = BigInt(Math.floor(nowSec));
  if (now < launch) return Number(start);
  const elapsed = now - launch;
  if (elapsed >= duration) return 0;
  const remaining = duration - elapsed;
  return Number((start * remaining + duration - 1n) / duration);
}

/** Unix seconds at which the surcharge reaches zero; null when the token launched without one. */
export function sniperEndsAt(cfg: HookFeeConfig): number | null {
  return cfg.surchargeStartBps === 0 ? null : cfg.launchTimestamp + cfg.decaySeconds;
}

export function describeFee(mode: VaradaMode, cfg: HookFeeConfig, feeBps: number): VaradaFeeInfo {
  const sniperBps = Math.max(0, feeBps - cfg.baseFeeBps);
  return {
    mode,
    feeBps,
    baseFeeBps: cfg.baseFeeBps,
    sniperBps,
    sniperActive: sniperBps > 0,
    sniperEndsAt: sniperEndsAt(cfg),
    sniperStartBps: cfg.surchargeStartBps,
    causeShareBps: CAUSE_FEE_SHARE_BPS,
    platformShareBps: PLATFORM_FEE_SHARE_BPS,
  };
}

/**
 * Reads a Varada token's current fee from its hook.
 *
 * Both hooks answer `currentFeeBps(token)` (base fee plus the decaying launch surcharge) and
 * `feeConfig(token)`. How the fee is charged differs, but the rate and its 90 / 10 split between
 * the cause pool and the platform do not:
 *  - `VaradaHook` (weekly): the base fee is the pool's LP fee on the input (accrues to the locked
 *    position and is collected later); the surcharge is taken by the hook from the swap's output
 *    and sent to the fee consolidator.
 *  - `VaradaLiveHook`: the LP fee is zero; the whole fee (base plus surcharge) is taken in the quote
 *    asset and converted to USDC for the active cause inside the swap.
 * Both are part of the swap itself, so the V4 quoter already includes them; `feeBps` is only for display.
 */
export async function readVaradaFee(
  client: ReadClient,
  token: Address,
  hook: Address,
  opts: { mode?: VaradaMode } = {},
): Promise<VaradaFeeInfo> {
  try {
    const [feeBps, cfg] = await Promise.all([
      client.readContract({ address: hook, abi: varadaHookFeeAbi, functionName: "currentFeeBps", args: [token] }),
      client.readContract({ address: hook, abi: varadaHookFeeAbi, functionName: "feeConfig", args: [token] }),
    ]);
    const mode = opts.mode ?? (await detectMode(client, hook));
    return describeFee(
      mode,
      {
        baseFeeBps: Number(cfg.baseFeeBps),
        surchargeStartBps: Number(cfg.surchargeStartBps),
        decaySeconds: Number(cfg.decaySeconds),
        launchTimestamp: Number(cfg.launchTimestamp),
      },
      Number(feeBps),
    );
  } catch (cause) {
    throw new SwapError("hook-reverted", "Could not read the token's fee from its hook", { cause });
  }
}

/** The live hook has a `vault()`; the weekly hook does not. */
export async function detectMode(client: ReadClient, hook: Address): Promise<VaradaMode> {
  try {
    await client.readContract({ address: hook, abi: varadaHookFeeAbi, functionName: "vault" });
    return "live";
  } catch {
    return "weekly";
  }
}

/** Splits a fee amount between the cause pool and the platform (platform rounds down). */
export function splitFee(amount: bigint): { cause: bigint; platform: bigint } {
  const platform = (amount * BigInt(PLATFORM_FEE_SHARE_BPS)) / 10_000n;
  return { platform, cause: amount - platform };
}
