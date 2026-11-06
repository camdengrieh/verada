import { planDonation, type DonationReader, type DonationStep } from "@verada/sdk";
import type { Address } from "viem";
import type { Log } from "../jobs/types.js";
import type { Step } from "./plan.js";

/** Plans `FeeVault.settle` and `DonationDistributor.distribute` for a finalized epoch. */
export interface DonationPlanner {
  plan(token: Address, epoch: bigint): Promise<Step>;
}

export interface DonationPlannerDeps {
  /** The SDK's donation reader over the keeper's RPC (`createDonationReader`). */
  reader: DonationReader;
  zamaScheme: Address;
  log: Log;
}

/**
 * After an epoch is finalized, the keeper settles it (`FeeVault.settle`, which first brings the
 * epoch's outstanding fees in) and donates it (`DonationDistributor.distribute`), from the SDK's
 * `planDonation` over chain state: the same plan the web app's "Send this week's donation" card
 * runs. The epoch is done (never read again) once donated, or settled with nothing pending.
 *
 * An empty epoch that is not settled (`NothingToSettle`) is not done: `FeeVault.depositFees`
 * credits late fees to the oldest unsettled epoch at or after their accrual epoch, so it can still
 * fill up (e.g. once a broken consolidator route is repaired). It is re-read every run while inside
 * the keeper's lookback (one batch of views and an `eth_call`) and logged once at info.
 *
 * Waiting (fees pending until the settle grace) keeps the epoch open without a log line. A blocked
 * epoch (e.g. `OrgNotActive`: Endaoment no longer lists the winning org) needs an owner or Endaoment
 * to act: it is logged at warn once per reason and re-read every run, so it moves on by itself
 * once fixed. Governor steps never come from here: the caller plans epochs that are not finalized.
 */
export function createDonationPlanner(deps: DonationPlannerDeps): DonationPlanner {
  /** `token:epoch:reason` already reported as blocked. */
  const reported = new Set<string>();

  return {
    async plan(token, epoch) {
      const state = await deps.reader.read(token, epoch);
      const step: DonationStep = planDonation(state, { zamaScheme: deps.zamaScheme });
      const key = `${token.toLowerCase()}:${epoch}`;
      switch (step.type) {
        case "done": {
          if (step.reason === "nothing-to-donate" && !state.settled) {
            const k = `${key}:empty`;
            if (!reported.has(k)) {
              if (reported.size >= 1_000) reported.clear();
              reported.add(k);
              deps.log("info", "keeper found nothing to donate for the epoch", { token, epoch });
            }
            return { type: "none", reason: step.reason, terminal: false };
          }
          for (const k of reported) if (k.startsWith(`${key}:`)) reported.delete(k);
          return { type: "none", reason: step.reason, terminal: true };
        }
        case "send":
          reported.delete(`${key}:empty`);
          if (step.contract === "feeVault") return { type: "send", action: { kind: "settle", token, epoch } };
          if (step.contract === "distributor") return { type: "send", action: { kind: "distribute", token, epoch } };
          return { type: "none", reason: `unexpected ${step.functionName} for a finalized epoch`, terminal: false };
        case "wait":
          return { type: "none", reason: step.reason, terminal: false };
        case "decrypt":
          return { type: "none", reason: "tally not decrypted", terminal: false };
        case "blocked": {
          const k = `${key}:${step.reason}`;
          if (!reported.has(k)) {
            if (reported.size >= 1_000) reported.clear();
            reported.add(k);
            deps.log("warn", "keeper cannot donate the epoch", { token, epoch, stage: step.stage, reason: step.reason, ...(step.error ? { revert: step.error } : {}) });
          }
          return { type: "none", reason: step.reason, terminal: false };
        }
      }
    },
  };
}
