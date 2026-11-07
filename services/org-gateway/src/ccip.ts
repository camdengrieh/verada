import {
  CcipRequestError,
  decodeCcipRequest,
  decodeCcipResponse,
  encodeCcipRequest,
  encodeCcipResponse,
} from "@varada/cause-catalog";
import { parseAbi, type Hex } from "viem";
import type { BuildSet } from "./store.js";

export { CcipRequestError, decodeCcipRequest, decodeCcipResponse, encodeCcipRequest, encodeCcipResponse };

/** `VaradaOrgResolver` reads the gateway uses. */
export const ORG_RESOLVER_ABI = parseAbi(["function root() view returns (bytes32)", "function previousRoot() view returns (bytes32)"]);

/**
 * Answers one lookup (`callData = abi.encode(uint256 shard)`) from the build whose names root matches
 * the resolver's on-chain root: `abi.encode(root, shard, entries, proof)`, the same bytes as the
 * static file `ccip/<callData>.json` that `varada-catalog export-ccip` writes.
 */
export function answerCcip(builds: BuildSet, data: string, onchainRoot: Hex | null): { data: Hex; root: Hex; shard: number } {
  const build = builds.select(onchainRoot);
  const shard = decodeCcipRequest(data, build.names.bits);
  const p = build.names.shardProof(shard)!;
  return { data: encodeCcipResponse(build.namesRoot, p), root: build.namesRoot, shard };
}
