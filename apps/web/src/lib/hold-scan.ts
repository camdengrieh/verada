import { prepareHoldScan, type HoldScanTarget } from "@varada/sdk";
import { epochGovernorAbi, rotationGovernorAbi, takeoverGovernorAbi } from "@varada/sdk/abis";
import type { Address, Hex, PublicClient } from "viem";

/** Governor ABI that has the target's `advanceHoldScan` (or `advanceProposeScan`). */
export function holdScanAbi(target: HoldScanTarget) {
  if (target.kind === "epoch") return epochGovernorAbi;
  if (target.kind === "rotation") return rotationGovernorAbi;
  return takeoverGovernorAbi;
}

/**
 * Before a ballot (or `proposeAt`): when the voter's hold window has too many checkpoints for one
 * transaction (a heavy trader, or dust sent to them), sends `advanceHoldScan` chunks from their
 * wallet, each confirmed before the next. Returns the chunks sent; zero in the common case.
 */
export async function runHoldScanStep(opts: {
  client: PublicClient;
  governor: Address;
  token: Address;
  voter: Address;
  target: HoldScanTarget;
  chainId: number;
  write: (call: { address: Address; abi: ReturnType<typeof holdScanAbi>; functionName: string; args: readonly unknown[]; chainId: number }) => Promise<Hex>;
  onChunk?: (done: number, total: number) => void;
}): Promise<number> {
  const abi = holdScanAbi(opts.target);
  return prepareHoldScan({
    client: opts.client,
    governor: opts.governor,
    token: opts.token,
    account: opts.voter,
    target: opts.target,
    onChunk: opts.onChunk,
    send: async (c) => {
      const hash = await opts.write({ address: opts.governor, abi, ...c, chainId: opts.chainId });
      const r = await opts.client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`hold scan transaction ${hash} reverted`);
    },
  });
}
