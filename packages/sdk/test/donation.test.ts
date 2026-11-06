import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { donationDistributorAbi, feeVaultAbi } from "../src/abis/index.js";
import { ballotCommitment } from "../src/catalog.js";
import {
  createDonationReader,
  donationCall,
  epochFinalizeNeedsOptions,
  epochNeedsTally,
  isRevertError,
  planDonation,
  planEpochGovernor,
  remainingStages,
  revertErrorName,
  type DonationState,
  type DonationStep,
  type EpochGovernorState,
} from "../src/donation.js";

const T = "0x00000000000000000000000000000000000000a1" as Address;
const EG = "0x00000000000000000000000000000000000000e1" as Address;
const FV = "0x00000000000000000000000000000000000000f1" as Address;
const DD = "0x00000000000000000000000000000000000000d1" as Address;
const ZAMA = "0x00000000000000000000000000000000000000c1" as Address;
const OTHER = "0x00000000000000000000000000000000000000c2" as Address;
const REG = "0x00000000000000000000000000000000000000b1" as Address;
const CAUSE = `0x${"aa".repeat(32)}` as Hex;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ORGS = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`] as Hex[];
const DAY = 86_400n;
const END = 1_000_000n;
const ctx = { zamaScheme: ZAMA };

const unopened: EpochGovernorState = { opened: false, closed: false, finalized: false, voterCount: 0n, scheme: zeroAddress };
const voted: EpochGovernorState = { opened: true, closed: false, finalized: false, voterCount: 3n, scheme: ZAMA };
const finalized: EpochGovernorState = { ...voted, closed: true, finalized: true };

function state(over: Partial<DonationState> = {}): DonationState {
  return {
    token: T,
    epoch: 4n,
    now: END + DAY,
    currentEpoch: 5n,
    epochStart: END - 7n * DAY,
    epochEnd: END,
    registered: true,
    governor: finalized,
    tallyGrace: 14n * DAY,
    defaultCause: CAUSE,
    winningCause: CAUSE,
    ballot: { commitment: ballotCommitment(ORGS), optionCount: ORGS.length },
    feeVaultRegistered: true,
    settled: false,
    epochPool: 100n,
    settleGrace: 7n * DAY,
    pending: 0n,
    distributed: false,
    ...over,
  };
}

const send = (step: DonationStep) => {
  if (step.type !== "send") throw new Error(`expected send, got ${JSON.stringify(step, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return step;
};

describe("planEpochGovernor (the keeper's epoch rules)", () => {
  it("follows the keeper's steps", () => {
    expect(planEpochGovernor(finalized, undefined, ctx)).toEqual({ type: "none", reason: "finalized", terminal: true });
    expect(planEpochGovernor(unopened, undefined, ctx)).toEqual({ type: "finalizeEpoch", needsOptions: false });
    expect(planEpochGovernor({ ...voted, voterCount: 0n }, undefined, ctx)).toEqual({ type: "finalizeEpoch", needsOptions: false });
    expect(planEpochGovernor(voted, undefined, ctx)).toEqual({ type: "closeEpoch" });
    const closed = { ...voted, closed: true };
    expect(planEpochGovernor(closed, undefined, ctx)).toMatchObject({ type: "none", terminal: false });
    expect(planEpochGovernor(closed, { isFinal: true, counts: [1n, 2n] }, ctx)).toEqual({ type: "finalizeEpoch", needsOptions: true });
    expect(planEpochGovernor(closed, { isFinal: false, counts: [] }, ctx)).toEqual({ type: "decrypt", scheme: ZAMA });
    expect(planEpochGovernor({ ...closed, scheme: OTHER }, { isFinal: false, counts: [] }, ctx)).toMatchObject({ type: "none", reason: "epoch scheme is not the Zama scheme" });
  });

  it("needs options and a tally only for epochs with ballots", () => {
    expect(epochFinalizeNeedsOptions(unopened)).toBe(false);
    expect(epochFinalizeNeedsOptions(voted)).toBe(true);
    expect(epochNeedsTally(voted)).toBe(false);
    expect(epochNeedsTally({ ...voted, closed: true })).toBe(true);
    expect(epochNeedsTally(finalized)).toBe(false);
  });
});

describe("planDonation", () => {
  it("is done once distributed", () => {
    expect(planDonation(state({ settled: true, distributed: true }), ctx)).toEqual({ type: "done", reason: "donated" });
  });

  it("is blocked for a token the governor does not know", () => {
    expect(planDonation(state({ registered: false }), ctx)).toMatchObject({ type: "blocked", reason: "not-registered" });
  });

  it("waits for a running epoch to end", () => {
    expect(planDonation(state({ epoch: 5n, governor: unopened }), ctx)).toEqual({ type: "wait", stage: "close", reason: "epoch-not-ended", until: END });
  });

  it("finalizes an epoch without ballots first (never closed)", () => {
    const step = send(planDonation(state({ governor: unopened }), ctx));
    expect(step).toMatchObject({ stage: "finalize", contract: "governor", functionName: "finalizeEpoch", args: [T, 4n, []] });
    const noVoters = send(planDonation(state({ governor: { ...voted, voterCount: 0n } }), ctx));
    expect(noVoters.functionName).toBe("finalizeEpoch");
  });

  it("is blocked when nobody voted and no default cause is set (NoVotes)", () => {
    expect(planDonation(state({ governor: unopened, defaultCause: ZERO32 }), ctx)).toMatchObject({ type: "blocked", stage: "finalize", reason: "no-default-cause" });
  });

  it("closes an epoch with ballots, and closes again after a failed close", () => {
    expect(send(planDonation(state({ governor: voted }), ctx))).toMatchObject({ stage: "close", functionName: "closeEpoch", args: [T, 4n] });
    const failed = { ...voted, closed: true, closeFailed: true };
    expect(send(planDonation(state({ governor: failed, tally: { isFinal: false, counts: [] } }), ctx)).functionName).toBe("closeEpoch");
  });

  it("asks for the tally to be decrypted while it is not final", () => {
    const closed = { ...voted, closed: true };
    expect(planDonation(state({ governor: closed, tally: { isFinal: false, counts: [] } }), ctx)).toEqual({ type: "decrypt", stage: "tally", scheme: ZAMA, token: T, scope: 4n });
  });

  it("waits on a poll of another scheme until the tally grace, then finalizes on the fallback", () => {
    const closed = { ...voted, closed: true, scheme: OTHER };
    const tally = { isFinal: false, counts: [] };
    expect(planDonation(state({ governor: closed, tally }), ctx)).toEqual({ type: "wait", stage: "tally", reason: "tally-other-scheme", until: END + 14n * DAY });
    const late = send(planDonation(state({ governor: closed, tally, now: END + 14n * DAY }), ctx));
    expect(late).toMatchObject({ functionName: "finalizeEpoch", args: [T, 4n, []] });
  });

  it("finalizes on the default cause after the tally grace instead of waiting on a decryption", () => {
    const closed = { ...voted, closed: true };
    const step = send(planDonation(state({ governor: closed, tally: { isFinal: false, counts: [] }, now: END + 15n * DAY }), ctx));
    expect(step).toMatchObject({ functionName: "finalizeEpoch", fallback: "tally-timeout" });
    expect(planDonation(state({ governor: closed, tally: { isFinal: false, counts: [] }, now: END + 15n * DAY, defaultCause: ZERO32 }), ctx)).toMatchObject({
      type: "blocked",
      reason: "no-default-cause",
    });
  });

  it("finalizes on the fallback after the tally grace when the scheme keeps refusing the close", () => {
    const failed = { ...voted, closed: true, closeFailed: true };
    const tally = { isFinal: false, counts: [] };
    const late = send(planDonation(state({ governor: failed, tally, now: END + 14n * DAY }), ctx));
    expect(late).toMatchObject({ stage: "finalize", functionName: "finalizeEpoch", args: [T, 4n, []], fallback: "tally-timeout" });
  });

  it("finalizes an epoch nobody closed on the fallback after the tally grace", () => {
    const step = send(planDonation(state({ governor: voted, now: END + 14n * DAY }), ctx));
    expect(step).toMatchObject({ functionName: "finalizeEpoch", fallback: "tally-timeout" });
    expect(send(planDonation(state({ governor: voted }), ctx)).functionName).toBe("closeEpoch");
  });

  it("applies a tally that is final after the grace, without the fallback", () => {
    const closed = { ...voted, closed: true };
    const step = send(planDonation(state({ governor: closed, tally: { isFinal: true, counts: [1n, 2n] }, now: END + 20n * DAY }), { ...ctx, orgIds: ORGS }));
    expect(step).toMatchObject({ args: [T, 4n, ORGS] });
    expect(step.fallback).toBeUndefined();
  });

  it("treats an inactive default cause like a missing one (NoVotes)", () => {
    const inactive = { defaultCauseActive: false };
    expect(planDonation(state({ governor: unopened, ...inactive }), ctx)).toMatchObject({ type: "blocked", stage: "finalize", reason: "no-default-cause" });
    const closed = { ...voted, closed: true };
    expect(planDonation(state({ governor: closed, tally: { isFinal: false, counts: [] }, now: END + 15n * DAY, ...inactive }), ctx)).toMatchObject({
      type: "blocked",
      reason: "no-default-cause",
    });
    expect(planDonation(state({ governor: closed, tally: { isFinal: true, counts: [0n, 0n] }, ...inactive }), { ...ctx, orgIds: ORGS })).toMatchObject({
      type: "blocked",
      reason: "no-default-cause",
    });
    // A vote that counted still wins without the default cause.
    expect(send(planDonation(state({ governor: closed, tally: { isFinal: true, counts: [1n, 2n] }, ...inactive }), { ...ctx, orgIds: ORGS })).functionName).toBe("finalizeEpoch");
    expect(send(planDonation(state({ governor: unopened, defaultCauseActive: true }), ctx)).functionName).toBe("finalizeEpoch");
  });

  it("finalizes a final tally with the ballot's org ids, checked against the commitment", () => {
    const closed = { ...voted, closed: true };
    const tally = { isFinal: true, counts: [1n, 2n] };
    expect(send(planDonation(state({ governor: closed, tally }), { ...ctx, orgIds: ORGS }))).toMatchObject({ args: [T, 4n, ORGS] });
    expect(planDonation(state({ governor: closed, tally }), ctx)).toMatchObject({ type: "blocked", reason: "ballot-options-unavailable" });
    expect(planDonation(state({ governor: closed, tally }), { ...ctx, orgIds: [...ORGS].reverse() })).toMatchObject({ type: "blocked", reason: "ballot-options-unavailable" });
    expect(planDonation(state({ governor: closed, tally }), { ...ctx, orgIds: ORGS.slice(0, 1) })).toMatchObject({ type: "blocked", reason: "ballot-options-unavailable" });
  });

  it("is blocked on a final tally that counted nothing without a default cause", () => {
    const closed = { ...voted, closed: true };
    expect(planDonation(state({ governor: closed, tally: { isFinal: true, counts: [0n, 0n] }, defaultCause: ZERO32 }), { ...ctx, orgIds: ORGS })).toMatchObject({
      type: "blocked",
      reason: "no-default-cause",
    });
  });

  it("settles a finalized epoch when the simulation passes", () => {
    expect(send(planDonation(state({ settleCheck: { ok: true } }), ctx))).toMatchObject({ stage: "settle", contract: "feeVault", functionName: "settle", args: [T, 4n] });
  });

  it("waits until the settle grace while fees are pending", () => {
    expect(planDonation(state({ settleCheck: { ok: false, error: "FeesPending" } }), ctx)).toEqual({ type: "wait", stage: "settle", reason: "fees-pending", until: END + 7n * DAY });
  });

  it("treats an empty pool as nothing to donate", () => {
    expect(planDonation(state({ epochPool: 0n, settleCheck: { ok: false, error: "NothingToSettle" } }), ctx)).toEqual({ type: "done", reason: "nothing-to-donate" });
  });

  it("reports other settle reverts as blocked", () => {
    expect(planDonation(state({ settleCheck: { ok: false, error: "EpochNotFinalized" } }), ctx)).toMatchObject({ type: "blocked", reason: "settle-reverts", error: "EpochNotFinalized" });
    expect(planDonation(state({ settleCheck: { ok: false } }), ctx)).toEqual({ type: "blocked", stage: "settle", reason: "settle-reverts" });
    expect(planDonation(state({ feeVaultRegistered: false }), ctx)).toMatchObject({ type: "blocked", reason: "fee-vault-not-registered" });
  });

  it("decides from the pool when settle was not simulated", () => {
    expect(send(planDonation(state(), ctx)).functionName).toBe("settle");
    expect(planDonation(state({ epochPool: 0n }), ctx)).toEqual({ type: "wait", stage: "settle", reason: "fees-pending", until: END + 7n * DAY });
    expect(planDonation(state({ epochPool: 0n, now: END + 7n * DAY }), ctx)).toEqual({ type: "done", reason: "nothing-to-donate" });
  });

  it("distributes a settled epoch", () => {
    const s = state({ settled: true, epochPool: 0n, pending: 90n });
    expect(send(planDonation(s, ctx))).toMatchObject({ stage: "distribute", contract: "distributor", functionName: "distribute", args: [T, 4n] });
    expect(send(planDonation({ ...s, distributeCheck: { ok: true } }, ctx)).functionName).toBe("distribute");
  });

  it("reports Endaoment org problems as blocked, not retried", () => {
    const s = state({ settled: true, pending: 90n });
    expect(planDonation({ ...s, distributeCheck: { ok: false, error: "OrgNotActive" } }, ctx)).toMatchObject({ type: "blocked", stage: "distribute", reason: "org-not-active" });
    expect(planDonation({ ...s, distributeCheck: { ok: false, error: "OrgAddressMismatch" } }, ctx)).toMatchObject({ type: "blocked", reason: "org-address-mismatch" });
    expect(planDonation({ ...s, distributeCheck: { ok: false, error: "InsufficientBalance" } }, ctx)).toMatchObject({ type: "blocked", reason: "distribute-reverts", error: "InsufficientBalance" });
  });

  it("is done with nothing pending after settlement (defensive)", () => {
    expect(planDonation(state({ settled: true, pending: 0n }), ctx)).toEqual({ type: "done", reason: "nothing-to-donate" });
  });
});

describe("remainingStages", () => {
  it("lists the stages from the step's on", () => {
    expect(remainingStages({ type: "send", stage: "close", contract: "governor", functionName: "closeEpoch", args: [] }, true)).toEqual(["close", "tally", "finalize", "settle", "distribute"]);
    expect(remainingStages({ type: "send", stage: "finalize", contract: "governor", functionName: "finalizeEpoch", args: [] }, false)).toEqual(["finalize", "settle", "distribute"]);
    expect(remainingStages({ type: "wait", stage: "settle", reason: "fees-pending" }, true)).toEqual(["settle", "distribute"]);
    expect(remainingStages({ type: "done", reason: "donated" }, true)).toEqual([]);
  });
});

describe("donationCall", () => {
  const addrs = { epochGovernor: EG, feeVault: FV, distributor: DD };
  it("targets the right contract with encodable calldata", () => {
    const fin = donationCall(send(planDonation(state({ governor: unopened }), ctx)), addrs);
    expect(fin.address).toBe(EG);
    expect(() => encodeFunctionData(fin as never)).not.toThrow();
    const settle = donationCall(send(planDonation(state({ settleCheck: { ok: true } }), ctx)), addrs);
    expect(settle.address).toBe(FV);
    expect(() => encodeFunctionData(settle as never)).not.toThrow();
    const dist = donationCall(send(planDonation(state({ settled: true, pending: 1n }), ctx)), addrs);
    expect(dist.address).toBe(DD);
    expect(() => encodeFunctionData(dist as never)).not.toThrow();
  });
});

/** A revert as viem reports it from `simulateContract`. */
function revert(abi: Abi, errorName: string, args: readonly unknown[]) {
  return new ContractFunctionRevertedError({ abi, data: encodeErrorResult({ abi, errorName, args } as never), functionName: "x" });
}

describe("createDonationReader", () => {
  type Chain = Record<string, unknown>;
  function client(values: Chain, sim: (fn: string) => Error | undefined = () => undefined) {
    const reads: string[] = [];
    const sims: string[] = [];
    return {
      reads,
      sims,
      async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) {
        reads.push(functionName);
        if (functionName === "epochStart") return (args?.[0] as bigint) === 4n ? END - 7n * DAY : END;
        if (functionName === "isRegistered") return address === FV ? values.vaultRegistered ?? true : values.registered ?? true;
        if (functionName === "tallyOf") {
          expect(address).toBe(ZAMA);
          expect(args).toEqual([EG, T, 4n]);
          if (values.tallyOf instanceof Error) throw values.tallyOf;
        }
        if (functionName === "isActive") {
          expect(address).toBe(REG);
          expect(args).toEqual([CAUSE]);
        }
        if (!(functionName in values)) throw new Error(`unexpected read ${functionName}`);
        return values[functionName];
      },
      async simulateContract({ functionName }: { functionName: string }) {
        sims.push(functionName);
        const err = sim(functionName);
        if (err) throw err;
        return { result: undefined };
      },
      async getBlock() {
        return { timestamp: END + DAY };
      },
    };
  }
  const base: Chain = {
    currentEpoch: 5n,
    isOpened: true,
    isClosed: true,
    closeFailed: false,
    isFinalized: true,
    voterCount: 3n,
    epochScheme: ZAMA,
    TALLY_GRACE: 14n * DAY,
    defaultCause: CAUSE,
    winningCause: CAUSE,
    ballotCommitment: [ballotCommitment(ORGS), 2],
    registry: REG,
    settled: false,
    causePoolOf: 100n,
    SETTLE_GRACE: 7n * DAY,
    pending: 0n,
    distributed: false,
  };

  it("reads the state and simulates settle once finalized", async () => {
    const c = client(base, (fn) => (fn === "settle" ? revert(feeVaultAbi as Abi, "FeesPending", [T, 4n]) : undefined));
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(s).toMatchObject({ now: END + DAY, currentEpoch: 5n, epochStart: END - 7n * DAY, epochEnd: END, ballot: { optionCount: 2 }, settleCheck: { ok: false, error: "FeesPending" } });
    expect(c.sims).toEqual(["settle"]);
    expect(planDonation(s, ctx)).toMatchObject({ type: "wait", reason: "fees-pending", until: END + 7n * DAY });
  });

  it("reads the tally of a closed epoch and simulates nothing", async () => {
    const c = client({ ...base, isFinalized: false, isActive: true, tallyOf: [false, []] });
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(s.tally).toEqual({ isFinal: false, counts: [] });
    expect(c.sims).toEqual([]);
    expect(planDonation(s, ctx)).toMatchObject({ type: "decrypt" });
  });

  it("reads whether the default cause is active while the epoch is not finalized", async () => {
    const c = client({ ...base, isOpened: false, isClosed: false, voterCount: 0n, isFinalized: false, isActive: false });
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(s.defaultCauseActive).toBe(false);
    expect(planDonation(s, ctx)).toMatchObject({ type: "blocked", reason: "no-default-cause" });
    const fin = client(base, () => undefined);
    await createDonationReader(fin, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(fin.reads).not.toContain("isActive");
  });

  it("reads a reverting tally as not final, as the governor does", async () => {
    const c = client({ ...base, isFinalized: false, isActive: true, tallyOf: revert(feeVaultAbi as Abi, "NothingToSettle", [T, 4n]) });
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(s.tally).toEqual({ isFinal: false, counts: [] });
  });

  it("simulates distribute once settled and decodes org errors", async () => {
    const c = client({ ...base, settled: true, pending: 90n }, (fn) => (fn === "distribute" ? revert(donationDistributorAbi as Abi, "OrgNotActive", [DD]) : undefined));
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(s.distributeCheck).toEqual({ ok: false, error: "OrgNotActive" });
    expect(planDonation(s, ctx)).toMatchObject({ type: "blocked", reason: "org-not-active" });
  });

  it("skips the follow-up reads when there is nothing to plan", async () => {
    const c = client({ ...base, settled: true, distributed: true });
    const s = await createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n);
    expect(c.sims).toEqual([]);
    expect(planDonation(s, ctx)).toEqual({ type: "done", reason: "donated" });
  });

  it("passes on RPC failures of a simulation", async () => {
    const c = client(base, () => new Error("network down"));
    await expect(createDonationReader(c, { epochGovernor: EG, feeVault: FV, distributor: DD }).read(T, 4n)).rejects.toThrow("network down");
  });
});

describe("revertErrorName", () => {
  it("decodes custom errors and ignores other errors", () => {
    expect(revertErrorName(revert(feeVaultAbi as Abi, "NothingToSettle", [T, 4n]))).toBe("NothingToSettle");
    expect(revertErrorName(new Error("x"))).toBeUndefined();
  });

  it("recognizes a revert from another copy of viem by name, through its cause chain", () => {
    const foreign = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError", data: { errorName: "FeesPending" } });
    const wrapped = Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError", cause: foreign });
    expect(isRevertError(wrapped)).toBe(true);
    expect(revertErrorName(wrapped)).toBe("FeesPending");
    expect(isRevertError(Object.assign(new Error("fetch failed"), { cause: new Error("ECONNRESET") }))).toBe(false);
  });
});
