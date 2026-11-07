import { describe, expect, it } from "vitest";
import { readEnv } from "../src/env";
import { deploymentRows, formatRows } from "../scripts/deployment-env";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const main = {
  chainId: 1,
  deployBlock: 23456789,
  factory: addr(1),
  hook: addr(20),
  lpLocker: addr(21),
  feeVault: addr(2),
  feeConsolidator: addr(3),
  quoteRegistry: addr(4),
  causeRegistry: addr(5),
  causeCatalog: addr(6),
  epochGovernor: addr(7),
  donationDistributor: addr(8),
  profileRegistry: addr(9),
  resolver: addr(22),
  takeoverGovernor: addr(10),
  votingScheme: addr(11),
  curatorRegistry: addr(12),
};
const live = { chainId: 1, rotationGovernor: addr(13), liveVault: addr(14), liveHook: addr(15) };

describe("deploymentRows", () => {
  it("produces an environment the indexer accepts, with the deploy block as backfill start", () => {
    const env = Object.fromEntries(deploymentRows(main, live).map((r) => [r.env, r.value]));
    const parsed = readEnv({ PONDER_RPC_URL_1: "http://localhost:8545", ...env });
    expect(parsed.startBlock).toBe(23456789);
    expect(parsed.factory).toBe(addr(1));
    expect(parsed.tokenRegistry).toBe(addr(9));
    expect(parsed.rotationGovernor).toBe(addr(13));
  });
  it("leaves the rotation governor out without a live record", () => {
    expect(deploymentRows(main).some((r) => r.env === "ROTATION_GOVERNOR_ADDRESS")).toBe(false);
  });
  it("prints cdk flags and env lines", () => {
    const rows = deploymentRows(main, live);
    expect(formatRows(rows, "cdk")).toContain("-c startBlock=23456789");
    expect(formatRows(rows, "cdk")).toContain(`-c tokenRegistryAddress=${addr(9)}`);
    expect(formatRows(rows, "env")).toContain("START_BLOCK=23456789");
  });
  it("rejects a missing block, a bad address and a chain mismatch", () => {
    expect(() => deploymentRows({ ...main, deployBlock: 0 })).toThrow(/deployBlock/);
    expect(() => deploymentRows({ ...main, factory: "0x12" })).toThrow(/factory/);
    expect(() => deploymentRows(main, { ...live, chainId: 11155111 })).toThrow(/different chain/);
  });
});
