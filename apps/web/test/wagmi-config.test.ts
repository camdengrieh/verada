import { http } from "viem";
import { describe, expect, it } from "vitest";
import type { PrivateRpc } from "@/lib/private-rpc";
import { createWagmiConfig } from "@/lib/wagmi";

const rpc = { transport: () => http("http://127.0.0.1:9") } as unknown as PrivateRpc;

describe("createWagmiConfig", () => {
  it("knows mainnet by default", () => {
    const config = createWagmiConfig(rpc);
    expect(config.chains.map((c) => c.id)).toEqual([1]);
  });

  it("knows a local fork that keeps anvil's chain id, so its writes and receipts are not 'Chain not configured'", () => {
    const config = createWagmiConfig(rpc, 31337);
    expect(config.chains.map((c) => c.id)).toEqual([31337]);
    expect(config.getClient({ chainId: 31337 as never })).toBeTruthy();
    expect(() => createWagmiConfig(rpc).getClient({ chainId: 31337 as never })).toThrow(/Chain not configured/);
  });
});
