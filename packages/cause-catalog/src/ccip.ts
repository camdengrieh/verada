import { decodeAbiParameters, encodeAbiParameters, isHex, type Hex } from "viem";
import { ENTRIES_ABI, SHARD_BITS, type NameEntry, type ShardProof } from "./names.js";

/**
 * CCIP-Read wire format of `VaradaOrgResolver` (EIP-3668). The resolver reverts with
 * `OffchainLookup(..., callData = abi.encode(uint256 shard), ...)`; the gateway, or the static
 * file `ccip/<callData>.json`, answers
 * `{"data": abi.encode(bytes32 root, uint256 shard, (bytes32,bytes32,bytes32,bytes32)[] entries, bytes32[] proof)}`.
 */
const REQUEST = [{ type: "uint256" }] as const;
const RESPONSE = [{ type: "bytes32" }, { type: "uint256" }, ENTRIES_ABI[0], { type: "bytes32[]" }] as const;

export class CcipRequestError extends Error {}

export const encodeCcipRequest = (shard: number): Hex => encodeAbiParameters(REQUEST, [BigInt(shard)]);

/** The shard of a request; throws {@link CcipRequestError} unless it is `abi.encode(uint256 shard)` in range. */
export function decodeCcipRequest(data: string, bits: number = SHARD_BITS): number {
  if (!isHex(data, { strict: true }) || data.length !== 66) throw new CcipRequestError("data must be abi.encode(uint256 shard)");
  const shard = decodeAbiParameters(REQUEST, data)[0];
  if (shard >= 2n ** BigInt(bits)) throw new CcipRequestError(`shard out of range (0..${2 ** bits - 1})`);
  return Number(shard);
}

export function encodeCcipResponse(root: Hex, p: Pick<ShardProof, "shard" | "entries" | "proof">): Hex {
  return encodeAbiParameters(RESPONSE, [
    root,
    BigInt(p.shard),
    p.entries as unknown as readonly [Hex, Hex, Hex, Hex][],
    [...p.proof],
  ]);
}

export function decodeCcipResponse(data: Hex): { root: Hex; shard: number; entries: NameEntry[]; proof: Hex[] } {
  const [root, shard, entries, proof] = decodeAbiParameters(RESPONSE, data);
  return { root, shard: Number(shard), entries: entries.map((e) => [...e] as unknown as NameEntry), proof: [...proof] };
}
