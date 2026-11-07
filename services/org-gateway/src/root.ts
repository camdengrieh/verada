import type { Address, Hex, PublicClient } from "viem";
import { ORG_RESOLVER_ABI } from "./ccip.js";

export interface RootReader {
  /** The resolver's current `root()`, cached; null when unknown (no resolver or RPC failing). */
  get(): Promise<Hex | null>;
}

/** Reads `root()` at most once per `ttlMs`; on an RPC error it keeps serving the last value. */
export function createRootReader(opts: {
  client: Pick<PublicClient, "readContract">;
  resolver: Address;
  ttlMs?: number;
  now?: () => number;
  onError?: (e: unknown) => void;
}): RootReader {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let value: Hex | null = null;
  let fetchedAt = -Infinity;
  let inflight: Promise<Hex | null> | null = null;
  return {
    async get() {
      if (now() - fetchedAt < ttl) return value;
      inflight ??= opts.client
        .readContract({ address: opts.resolver, abi: ORG_RESOLVER_ABI, functionName: "root" })
        .then((r) => {
          value = r;
          fetchedAt = now();
          return value;
        })
        .catch((e) => {
          opts.onError?.(e);
          fetchedAt = now() - ttl + Math.min(ttl, 5_000); // retry in about 5 s
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

export const noRoot: RootReader = { get: async () => null };
