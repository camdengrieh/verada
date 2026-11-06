import { ballotCommitment, type DonationReader, type DonationState } from "@verada/sdk";
import { type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/env.js";
import { createTallyKeeperJob } from "../src/jobs/tally-keeper.js";
import { Backoff } from "../src/keeper/backoff.js";
import { KeeperRevert, type ChainWriter, type KeeperAction } from "../src/keeper/chain.js";
import { createDonationPlanner } from "../src/keeper/donate.js";
import { createKeeper } from "../src/keeper/keeper.js";
import { collectLogs, EG, EPOCH_ZERO, FakeChain, TG, token, WEEK, ZAMA } from "./keeper-fakes.js";

const T1 = token(1);
const CAUSE = `0x${"cc".repeat(32)}` as Hex;
const DAY = 86_400n;

interface VaultEpoch {
  pool: bigint;
  settled: boolean;
  pending: bigint;
  distributed: boolean;
  /** Settling reverts `FeesPending` (fees not brought in, grace not over). */
  feesPending: boolean;
  /** `distribute` reverts `OrgNotActive`. */
  orgInactive: boolean;
}

/** FeeVault + DonationDistributor beside the fake governor, with the contracts' guards. */
class FakeVault {
  epochs = new Map<string, VaultEpoch>();
  reads = 0;
  constructor(readonly chain: FakeChain) {}

  of(t: Address, e: bigint): VaultEpoch {
    const k = `${t}:${e}`.toLowerCase();
    let v = this.epochs.get(k);
    if (!v) this.epochs.set(k, (v = { pool: 0n, settled: false, pending: 0n, distributed: false, feesPending: false, orgInactive: false }));
    return v;
  }

  private settleError(t: Address, e: bigint): string | undefined {
    const v = this.of(t, e);
    if (!this.chain.epochOf(t, e).finalized) return "EpochNotFinalized";
    if (v.settled) return "AlreadySettled";
    if (v.feesPending) return "FeesPending";
    if (v.pool === 0n) return "NothingToSettle";
    return undefined;
  }

  private distributeError(t: Address, e: bigint): string | undefined {
    const v = this.of(t, e);
    if (!this.chain.epochOf(t, e).finalized) return "EpochNotFinalized";
    if (v.distributed) return "AlreadyDistributed";
    if (v.pending === 0n) return "NothingToDistribute";
    if (v.orgInactive) return "OrgNotActive";
    return undefined;
  }

  apply(a: Extract<KeeperAction, { kind: "settle" | "distribute" }>, dry: boolean) {
    const err = a.kind === "settle" ? this.settleError(a.token, a.epoch) : this.distributeError(a.token, a.epoch);
    if (err) throw new KeeperRevert(err, `would revert ${err}`);
    if (dry) return;
    const v = this.of(a.token, a.epoch);
    if (a.kind === "settle") Object.assign(v, { settled: true, pending: v.pool, pool: 0n });
    else Object.assign(v, { distributed: true, pending: 0n });
  }

  /** What the SDK's `createDonationReader` would read from these contracts. */
  reader(): DonationReader {
    return {
      read: async (t, e) => {
        this.reads++;
        const g = this.chain.epochOf(t, e);
        const v = this.of(t, e);
        const check = (err: string | undefined) => (err ? { ok: false as const, error: err } : { ok: true as const });
        const s: DonationState = {
          token: t,
          epoch: e,
          now: EPOCH_ZERO + this.chain.current * WEEK + DAY,
          currentEpoch: this.chain.current,
          epochStart: EPOCH_ZERO + e * WEEK,
          epochEnd: EPOCH_ZERO + (e + 1n) * WEEK,
          registered: this.chain.registered.has(t.toLowerCase()),
          governor: { opened: g.opened, closed: g.closed, finalized: g.finalized, voterCount: g.voters, scheme: g.scheme, closeFailed: false },
          tallyGrace: 14n * DAY,
          defaultCause: CAUSE,
          winningCause: g.finalized ? CAUSE : (`0x${"00".repeat(32)}` as Hex),
          ballot: { commitment: ballotCommitment([]), optionCount: 0 },
          feeVaultRegistered: true,
          settled: v.settled,
          epochPool: v.pool,
          settleGrace: 7n * DAY,
          pending: v.pending,
          distributed: v.distributed,
        };
        if (g.finalized && !v.settled) s.settleCheck = check(this.settleError(t, e));
        else if (g.finalized && v.settled && v.pending > 0n) s.distributeCheck = check(this.distributeError(t, e));
        return s;
      },
    };
  }

  /** The fake governor's writer, with settle and distribute applied here. */
  writer(): ChainWriter {
    const base = this.chain.writer();
    return {
      account: base.account,
      estimate: async (a) => {
        if (a.kind === "settle" || a.kind === "distribute") {
          this.apply(a, true);
          return 100_000n;
        }
        return base.estimate(a);
      },
      send: async (a, gas) => {
        if (a.kind === "settle" || a.kind === "distribute") {
          this.apply(a, false);
          this.chain.sent.push(a);
          return { hash: `0x${"ab".repeat(32)}`, status: "success", gasUsed: 90_000n };
        }
        return base.send(a, gas);
      },
    };
  }
}

function setup(chain: FakeChain, vault: FakeVault, opts: { donation?: boolean } = {}) {
  const { logs, log } = collectLogs();
  const keeper = createKeeper({
    reader: chain.reader(),
    writer: vault.writer(),
    decryptor: chain.decryptor(),
    tokens: async () => [T1],
    epochGovernor: EG,
    takeoverGovernor: TG,
    zamaScheme: ZAMA,
    dryRun: false,
    maxTxPerRun: 10,
    lookbackEpochs: 1,
    log,
    backoff: new Backoff({ baseMs: 60_000, maxMs: 600_000, now: () => 1_000_000 }),
    donation: opts.donation === false ? undefined : createDonationPlanner({ reader: vault.reader(), zamaScheme: ZAMA, log }),
  });
  return { keeper, logs };
}

const kinds = (c: FakeChain) => c.sent.map((a) => a.kind);

describe("keeper donations", () => {
  it("finalizes, settles and distributes an ended epoch in one run, then stops following it", async () => {
    const chain = new FakeChain().register(T1);
    const vault = new FakeVault(chain);
    vault.of(T1, 9n).pool = 500n;
    const { keeper } = setup(chain, vault);
    const s = await keeper.run();
    expect(kinds(chain)).toEqual(["finalizeEpoch", "settle", "distribute"]);
    expect(chain.sent[1]).toEqual({ kind: "settle", token: T1, epoch: 9n });
    expect(vault.of(T1, 9n)).toMatchObject({ settled: true, distributed: true });
    expect(s.txs).toBe(3);
    const reads = vault.reads;
    await keeper.run();
    expect(kinds(chain)).toHaveLength(3);
    expect(vault.reads).toBe(reads);
  });

  it("closes, decrypts and finalizes a voted epoch before it settles", async () => {
    const chain = new FakeChain().register(T1);
    chain.openEpoch(T1, 9n, 2n, [3n, 1n]);
    const vault = new FakeVault(chain);
    vault.of(T1, 9n).pool = 500n;
    const { keeper } = setup(chain, vault);
    await keeper.run();
    // Four steps per item and run: the donation follows on the next run.
    expect(kinds(chain)).toEqual(["closeEpoch", "submitTally", "finalizeEpoch", "settle"]);
    await keeper.run();
    expect(kinds(chain).at(-1)).toBe("distribute");
  });

  it("waits while the epoch's fees are pending, then settles", async () => {
    const chain = new FakeChain().register(T1);
    chain.epochOf(T1, 9n).finalized = true;
    const vault = new FakeVault(chain);
    Object.assign(vault.of(T1, 9n), { pool: 500n, feesPending: true });
    const { keeper, logs } = setup(chain, vault);
    await keeper.run();
    expect(kinds(chain)).toEqual([]);
    expect(logs.filter((l) => l.level !== "info")).toEqual([]);
    vault.of(T1, 9n).feesPending = false;
    await keeper.run();
    expect(kinds(chain)).toEqual(["settle", "distribute"]);
  });

  it("treats an empty pool as nothing to donate and stops there", async () => {
    const chain = new FakeChain().register(T1);
    chain.epochOf(T1, 9n).finalized = true;
    const vault = new FakeVault(chain);
    const { keeper, logs } = setup(chain, vault);
    await keeper.run();
    expect(kinds(chain)).toEqual([]);
    expect(logs.find((l) => l.msg === "keeper found nothing to donate for the epoch")).toMatchObject({ level: "info", data: { token: T1, epoch: 9n } });
    const reads = vault.reads;
    await keeper.run();
    expect(vault.reads).toBe(reads);
  });

  it("reports an inactive org at warn once and keeps following the epoch", async () => {
    const chain = new FakeChain().register(T1);
    chain.epochOf(T1, 9n).finalized = true;
    const vault = new FakeVault(chain);
    Object.assign(vault.of(T1, 9n), { settled: true, pending: 450n, orgInactive: true });
    const { keeper, logs } = setup(chain, vault);
    await keeper.run();
    await keeper.run();
    const warned = logs.filter((l) => l.msg === "keeper cannot donate the epoch");
    expect(warned).toEqual([{ level: "warn", msg: "keeper cannot donate the epoch", data: { token: T1, epoch: 9n, stage: "distribute", reason: "org-not-active", revert: "OrgNotActive" } }]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    expect(kinds(chain)).toEqual([]);
    vault.of(T1, 9n).orgInactive = false;
    await keeper.run();
    expect(kinds(chain)).toEqual(["distribute"]);
  });

  it("leaves finalized epochs alone without the donation planner", async () => {
    const chain = new FakeChain().register(T1);
    const vault = new FakeVault(chain);
    vault.of(T1, 9n).pool = 500n;
    const { keeper } = setup(chain, vault, { donation: false });
    await keeper.run();
    expect(kinds(chain)).toEqual(["finalizeEpoch"]);
    expect(vault.reads).toBe(0);
  });
});

describe("tally-keeper job donations", () => {
  const keeperEnv = {
    KEEPER_ENABLED: "true",
    KEEPER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    ETH_RPC_URL: "https://rpc.example/v2/key",
    EPOCH_GOVERNOR_ADDRESS: EG,
    VOTING_SCHEME_ADDRESS: ZAMA,
    TAKEOVER_GOVERNOR_ADDRESS: TG,
  };
  const FV = "0x00000000000000000000000000000000000000f1";
  const DD = "0x00000000000000000000000000000000000000d1";

  it("reads FEE_VAULT_ADDRESS and DONATION_DISTRIBUTOR_ADDRESS", () => {
    const k = readConfig({ ...keeperEnv, FEE_VAULT_ADDRESS: FV, DONATION_DISTRIBUTOR_ADDRESS: DD }).keeper;
    expect(k.feeVault?.toLowerCase()).toBe(FV);
    expect(k.donationDistributor?.toLowerCase()).toBe(DD);
    expect(() => readConfig({ ...keeperEnv, FEE_VAULT_ADDRESS: "0x123" })).toThrow(/FEE_VAULT_ADDRESS/);
  });

  it("settles and distributes only with both addresses", async () => {
    const { logs, log } = collectLogs();
    const off = createTallyKeeperJob({ keeper: readConfig(keeperEnv).keeper, chainId: 1, log });
    expect(off).not.toBeNull();
    expect(logs.find((l) => l.msg === "tally keeper ready")?.data).toMatchObject({ donations: "off" });
    expect(logs.find((l) => /FEE_VAULT_ADDRESS/.test(l.msg))?.level).toBe("warn");

    logs.length = 0;
    const chain = new FakeChain().register(T1);
    chain.current = 1n;
    const vault = new FakeVault(chain);
    vault.of(T1, 0n).pool = 7n;
    const job = createTallyKeeperJob({
      keeper: readConfig({ ...keeperEnv, FEE_VAULT_ADDRESS: FV, DONATION_DISTRIBUTOR_ADDRESS: DD }).keeper,
      chainId: 1,
      chain: { reader: chain.reader(), writer: vault.writer(), factoryLogs: { tokensCreated: async () => ({ tokens: [T1], toBlock: 1n }) }, donation: vault.reader() },
      decryptor: chain.decryptor(),
      log,
    })!;
    expect(logs.find((l) => l.msg === "tally keeper ready")?.data).toMatchObject({ donations: "settle, distribute" });
    await job.run();
    expect(kinds(chain)).toEqual(["finalizeEpoch", "settle", "distribute"]);
  });
});
