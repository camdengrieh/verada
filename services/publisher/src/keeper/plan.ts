import { epochFinalizeNeedsOptions, epochNeedsTally as sdkEpochNeedsTally, periodPollScope, planEpochGovernor, rotationPollScope, type RoundStatus } from "@varada/sdk";
import { zeroAddress, type Address } from "viem";
import {
  sameAddress,
  TERMINAL_PERIOD_STATES,
  TERMINAL_PROPOSAL_STATES,
  type EpochView,
  type KeeperAction,
  type Outcome,
  type PeriodProposalView,
  type ProposalView,
  type RoundView,
  type Tally,
} from "./chain.js";

/** What to do next for one epoch, proposal or rotation round, decided from chain state alone. */
export type Step =
  | { type: "none"; reason: string; terminal: boolean }
  | { type: "send"; action: KeeperAction }
  /**
   * Decrypt the poll and submit the result: per-option tallies (`submitTally`), or with `outcome`
   * only the winner of a poll closed for its outcome (`submitOutcome`, rotation rounds).
   */
  | { type: "decrypt"; scheme: Address; governor: Address; token: Address; scope: bigint; outcome?: boolean };

const none = (reason: string, terminal = false): Step => ({ type: "none", reason, terminal });

/** Finalizing an epoch with ballots needs its options (org ids) as calldata. */
export const finalizeNeedsOptions = (v: EpochView) => epochFinalizeNeedsOptions(v);

/** The tally is only needed once the poll has ballots and is closed. */
export const epochNeedsTally = (v: EpochView) => sdkEpochNeedsTally(v);

/**
 * Next step for an ended epoch (`epoch < currentEpoch`) of a registered token: the SDK's
 * `planEpochGovernor` (shared with the web app's donation card), as keeper actions.
 *
 * - finalized: nothing, ever again.
 * - never opened, or opened without ballots: `finalizeEpoch` (the default cause wins; reverts
 *   `NoVotes` while none is set). Such an epoch is never closed, which saves a public decryption.
 * - opened with ballots, not closed: `closeEpoch` (makes the tallies publicly decryptable).
 * - closed, tally not final: decrypt the tally and `submitTally`, if the epoch's scheme is the
 *   configured Zama scheme.
 * - closed, tally final: `finalizeEpoch`. Its `orgIds` are left empty here: the caller fills them
 *   from the ballot's `BallotPrepared` log ({@link finalizeNeedsOptions}).
 */
export function planEpoch(
  token: Address,
  epoch: bigint,
  v: EpochView,
  tally: Tally | undefined,
  ctx: { epochGovernor: Address; zamaScheme: Address },
): Step {
  const step = planEpochGovernor(v, tally, ctx);
  switch (step.type) {
    case "none":
      return none(step.reason, step.terminal);
    case "closeEpoch":
      return { type: "send", action: { kind: "closeEpoch", token, epoch } };
    case "finalizeEpoch":
      return { type: "send", action: { kind: "finalizeEpoch", token, epoch, orgIds: [] } };
    case "decrypt":
      return { type: "decrypt", scheme: step.scheme, governor: ctx.epochGovernor, token, scope: epoch };
  }
}

export const proposalNeedsTally = (p: ProposalView) => p.state === "Closing" && p.closed && !p.tallied;

/**
 * Next step for a takeover proposal.
 *
 * - Closing, not closed: `closeProposal`.
 * - Closing, closed, scheme tally not final: decrypt and `submitTally(takeoverGovernor, token, id)`.
 * - Closing, closed, scheme tally final (so not yet tallied): `recordTally`.
 * - Succeeded: `execute`.
 * - Active: wait. Defeated, Executed, Canceled, Expired: nothing, ever again.
 */
export function planProposal(
  id: bigint,
  p: ProposalView,
  tally: Tally | undefined,
  ctx: { takeoverGovernor: Address; zamaScheme: Address },
): Step {
  if (TERMINAL_PROPOSAL_STATES.includes(p.state)) return none(p.state, true);
  if (p.state === "Succeeded") return { type: "send", action: { kind: "execute", id } };
  if (p.state !== "Closing") return none(p.state);
  if (!p.closed) return { type: "send", action: { kind: "closeProposal", id } };
  if (p.tallied) return none("tallied");
  if (!tally) return none("tally not read");
  if (tally.isFinal) return { type: "send", action: { kind: "recordTally", id } };
  if (p.scheme === zeroAddress || !sameAddress(p.scheme, ctx.zamaScheme)) return none("proposal scheme is not the Zama scheme");
  return { type: "decrypt", scheme: p.scheme, governor: ctx.takeoverGovernor, token: p.token, scope: id };
}

/** Round statuses a round never leaves (every one but `None`, `Open` and `Closed`). */
export const FINAL_ROUND_STATUSES: readonly RoundStatus[] = ["NoChange", "Applied", "Stale", "InactiveWinner", "NoBallot"];

/** The outcome is only needed once the round's poll was closed for it. */
export const roundNeedsOutcome = (v: RoundView) => v.status === "Closed";

/**
 * Next step for a rotation round of a registered live token, from its state and the chain's time
 * (seconds). A round in status `None` that can still be prepared is the ballot preparer's
 * (`RoundPreparer`), not this function's.
 *
 * - final status: nothing, ever again.
 * - never prepared: nothing (it can no longer be, once its rotation has started).
 * - open, voting: wait for `voteEnd`.
 * - open, voting ended without ballots: nothing, ever again. With no ballot nothing would change
 *   and nothing would be decrypted, so the round is never closed (as an epoch without ballots is
 *   never closed), which saves a transaction per round.
 * - open, voting ended with ballots: `closeRound` (asks the scheme to reveal the winner only, or
 *   ends the round `NoChange` below `minVoters`).
 * - closed, outcome not final: decrypt the outcome and `submitOutcome`, if the round's scheme is
 *   the configured Zama scheme.
 * - closed, outcome final: `finalizeRound` (applies the winner from the next boundary).
 */
export function planRound(
  token: Address,
  target: bigint,
  v: RoundView,
  outcome: Outcome | undefined,
  now: bigint,
  ctx: { rotationGovernor: Address; zamaScheme: Address },
): Step {
  if (FINAL_ROUND_STATUSES.includes(v.status)) return none(v.status, true);
  if (v.status === "None") return none("round not prepared", true);
  if (v.status === "Open") {
    if (now < v.voteEnd) return none("voting");
    if (v.voters === 0n) return none("voting ended without ballots", true);
    return { type: "send", action: { kind: "closeRound", token, target } };
  }
  if (!outcome) return none("outcome not read");
  if (outcome.isFinal) return { type: "send", action: { kind: "finalizeRound", token, target } };
  if (v.scheme === zeroAddress || !sameAddress(v.scheme, ctx.zamaScheme)) return none("round scheme is not the Zama scheme");
  return { type: "decrypt", scheme: v.scheme, governor: ctx.rotationGovernor, token, scope: rotationPollScope(target), outcome: true };
}

/** The outcome is only needed once the proposal's poll was closed for it. */
export const periodProposalNeedsOutcome = (p: PeriodProposalView) => p.state === "Closed";

/**
 * Next step for a `RotationGovernor` period-change proposal, from its state and the chain's time
 * (seconds). Mirrors the takeover steps (close, decrypt, execute) with an outcome-only poll.
 *
 * - Active: wait. Defeated, Executed, Expired, Canceled: nothing, ever again.
 * - Ended: `closePeriodProposal` (below `minVoters` this defeats it, with nothing decrypted).
 * - Closed, outcome final: `executePeriodProposal` (schedules the new period if FOR won).
 * - Closed, outcome not final, past `executionDeadline`: `executePeriodProposal`, which expires
 *   it, freeing the token's slot for that period and starting its cooldown.
 * - Closed, outcome not final: decrypt the winner and `submitOutcome` (scope
 *   `PollScopeLib.encode(KIND_PERIOD, id)`), if the proposal's scheme is the Zama scheme.
 */
export function planPeriodProposal(
  id: bigint,
  p: PeriodProposalView,
  outcome: Outcome | undefined,
  now: bigint,
  ctx: { rotationGovernor: Address; zamaScheme: Address },
): Step {
  if (TERMINAL_PERIOD_STATES.includes(p.state)) return none(p.state, true);
  if (p.state === "None") return none("unknown proposal", true);
  if (p.state === "Active") return none("voting");
  if (p.state === "Ended") return { type: "send", action: { kind: "closePeriodProposal", id } };
  if (!outcome) return none("outcome not read");
  if (outcome.isFinal || now > p.executionDeadline) return { type: "send", action: { kind: "executePeriodProposal", id } };
  if (p.scheme === zeroAddress || !sameAddress(p.scheme, ctx.zamaScheme)) return none("proposal scheme is not the Zama scheme");
  return { type: "decrypt", scheme: p.scheme, governor: ctx.rotationGovernor, token: p.token, scope: periodPollScope(id), outcome: true };
}
