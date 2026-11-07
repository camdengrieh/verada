import { afterEach, describe, expect, it, vi } from "vitest";
import { installDevWallet } from "@/lib/dev-wallet";

// A throwaway key that exists only in this test.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function announced() {
  let provider: { request(a: { method: string; params?: unknown }): Promise<unknown> } | undefined;
  const on = (e: Event) => {
    provider = (e as CustomEvent).detail.provider;
  };
  window.addEventListener("eip6963:announceProvider", on);
  return { get: () => provider, stop: () => window.removeEventListener("eip6963:announceProvider", on) };
}

describe("dev wallet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("announces over EIP-6963, answers requests again on demand and disposes", async () => {
    const seen = announced();
    const w = installDevWallet("http://127.0.0.1:1", KEY, 1);
    expect(w.address).toBe(ADDRESS);
    expect(seen.get()).toBeDefined();
    expect(await seen.get()!.request({ method: "eth_requestAccounts" })).toEqual([ADDRESS]);
    expect(await seen.get()!.request({ method: "eth_chainId" })).toBe("0x1");
    seen.stop();

    const again = announced();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    expect(again.get()).toBeDefined();
    again.stop();

    w.dispose();
    const after = announced();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    expect(after.get()).toBeUndefined();
    after.stop();
  });

  it("signs messages locally and forwards reads to the node", async () => {
    const seen = announced();
    const w = installDevWallet("http://node.test", KEY, 1);
    const sig = (await seen.get()!.request({ method: "personal_sign", params: ["0x68656c6c6f", ADDRESS] })) as string;
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);

    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ result: "0x10" }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await seen.get()!.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({ method: "eth_blockNumber" });
    w.dispose();
    seen.stop();
  });

  it("rejects a malformed key", () => {
    expect(() => installDevWallet("http://node.test", "0x1234", 1)).toThrow(/32-byte/);
  });
});
