import { describe, expect, it, vi } from "vitest";
import type { PrivateRpcConfig } from "@/lib/config";
import { jsonRpcProvider, PrivateRpc, PrivateRpcUnavailableError, type WorkerLike } from "@/lib/private-rpc";

const cfg: PrivateRpcConfig = { network: "nym", rpcUrls: ["https://rpc.example"] };
const nox: PrivateRpcConfig = { network: "nox", rpcUrls: ["https://rpc.example"] };
const alice = "0x00000000000000000000000000000000000000a1" as const;
const bob = "0x00000000000000000000000000000000000000b2" as const;

/** Direct fetch for the bootstrap read: answers `eth_chainId` with `chainIdHex` and records the URLs. */
function bootFetch(chainIdHex = "0x1") {
  const urls: string[] = [];
  const methods: string[] = [];
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    const req = JSON.parse(String(init?.body)) as { id: number; method: string };
    methods.push(req.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_chainId" ? chainIdHex : "0x" }));
  });
  return { f: f as unknown as typeof fetch, mock: f, urls, methods };
}

function fakeWorker(fail?: Error) {
  const calls: { input: unknown; init: Record<string, unknown> }[] = [];
  const worker: WorkerLike = {
    ready: fail ? Promise.reject(fail) : Promise.resolve(),
    fetch: vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
      calls.push({ input, init: init ?? {} });
      // Answer single and batched JSON-RPC bodies.
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id: number } | { id: number }[]) : { id: 1 };
      const answer = (b: { id: number }) => ({ jsonrpc: "2.0", id: b.id, result: "0x1" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    }) as unknown as WorkerLike["fetch"],
    close: vi.fn(),
  };
  if (fail) worker.ready.catch(() => {});
  return { worker, calls };
}

describe("PrivateRpc", () => {
  it("passes the network's specifier and a bootstrap provider to the worker", async () => {
    const { worker } = fakeWorker();
    const factory = vi.fn().mockResolvedValue(worker);
    const boot = bootFetch("0x1");
    const rpc = new PrivateRpc(cfg, { factory, directFetch: boot.f });
    await rpc.fetch("https://rpc.example", { method: "POST" });
    const init = factory.mock.calls[0]![0];
    expect(init.address).toBe("0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0");
    expect(typeof init.preExisting.rpcProvider.request).toBe("function");
    // A mainnet specifier is read through the first anonymized RPC.
    expect(boot.urls).toEqual(["https://rpc.example"]);
    expect(boot.methods).toEqual(["eth_chainId"]);
    expect(rpc.getStatus()).toEqual({ state: "ready" });
  });

  it("reads the Nox specifier through a Sepolia bootstrap RPC, not the mainnet list", async () => {
    const { worker } = fakeWorker();
    const factory = vi.fn().mockResolvedValue(worker);
    const boot = bootFetch("0xaa36a7");
    const rpc = new PrivateRpc(nox, { factory, directFetch: boot.f });
    expect(rpc.network.label).toBe("Nox mixnet");
    expect(rpc.bootstrapRpcUrls()[0]).toMatch(/^https:\/\/ethereum-sepolia-rpc\.publicnode\.com/);
    await rpc.fetch("https://rpc.example", { method: "POST" });
    expect(factory.mock.calls[0]![0].address).toBe("0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A");
    expect(boot.urls[0]).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(boot.urls).not.toContain("https://rpc.example");
    expect(rpc.getStatus()).toEqual({ state: "ready" });
  });

  it("refuses a bootstrap RPC that serves a different chain than the specifier's", async () => {
    const factory = vi.fn();
    const boot = bootFetch("0x1");
    const rpc = new PrivateRpc({ ...nox, bootstrapRpcUrl: "https://mainnet.example" }, { factory, directFetch: boot.f });
    const err = await rpc.fetch("u", {}, { kind: "account", address: alice }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivateRpcUnavailableError);
    expect((err as PrivateRpcUnavailableError).code).toBe("bootstrap-chain");
    expect((err as Error).message).toMatch(/chain 1.*chain 11155111/);
    expect(factory).not.toHaveBeenCalled();
    expect(rpc.getStatus()).toMatchObject({ state: "failed", code: "bootstrap-chain" });
    expect(boot.urls).toEqual(["https://mainnet.example"]);
  });

  it("uses a separate, stable isolation key per account and for public data", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker, directFetch: bootFetch().f });
    await rpc.fetch("u", {}, { kind: "account", address: alice });
    await rpc.fetch("u", {}, { kind: "account", address: bob });
    await rpc.fetch("u", {}, { kind: "account", address: alice });
    await rpc.fetch("u", {}, { kind: "public" });
    const keys = calls.map((c) => (c.init.anonOptions as { isolationKey: string }).isolationKey);
    expect(keys[0]).toBe(keys[2]);
    expect(new Set(keys).size).toBe(3);
    expect(keys.join()).not.toContain(alice.slice(2));
  });

  it("isolates wagmi traffic under the connected account", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker, directFetch: bootFetch().f });
    const f = rpc.fetchFor();
    rpc.setAccount(alice);
    await f("u", { method: "POST" });
    expect((calls[0]!.init.anonOptions as { isolationKey: string }).isolationKey).toBe(
      rpc.isolationKey({ kind: "account", address: alice }),
    );
  });

  it("fails closed for account data even when the user allowed direct public reads", async () => {
    const direct = vi.fn().mockResolvedValue(new Response("{}"));
    const rpc = new PrivateRpc(cfg, { factory: async () => fakeWorker(new Error("mixnet down")).worker, directFetch: direct });
    await expect(rpc.fetch("u", {}, { kind: "account", address: alice })).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    expect(rpc.getStatus()).toMatchObject({ state: "failed", message: "mixnet down" });

    rpc.allowDirectForPublic(true);
    await expect(rpc.fetch("u", {}, { kind: "account", address: alice })).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    await rpc.fetch("https://rpc.example", {}, { kind: "public" });
    // Direct calls: the bootstrap chain check (to the bootstrap RPC) and the explicit public opt-in.
    expect(direct).toHaveBeenCalledTimes(2);
    expect(String(direct.mock.calls[0]![1]?.body)).toContain("eth_chainId");
    expect(direct.mock.calls[1]![0]).toBe("https://rpc.example");
  });

  it("never goes direct for public data unless the user opts in", async () => {
    const direct = vi.fn();
    const rpc = new PrivateRpc(cfg, { factory: async () => fakeWorker(new Error("down")).worker, directFetch: direct });
    await expect(rpc.fetch("u")).rejects.toBeInstanceOf(PrivateRpcUnavailableError);
    // The only direct request is the bootstrap chain check; no data read went direct.
    expect(direct).toHaveBeenCalledTimes(1);
    expect(String(direct.mock.calls[0]![1]?.body)).toContain("eth_chainId");
  });

  it("retry replaces a failed worker", async () => {
    const bad = fakeWorker(new Error("down")).worker;
    const good = fakeWorker().worker;
    const factory = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    const rpc = new PrivateRpc(cfg, { factory, directFetch: bootFetch().f });
    await expect(rpc.fetch("u")).rejects.toThrow();
    await rpc.retry();
    expect(rpc.getStatus()).toEqual({ state: "ready" });
    await expect(rpc.fetch("u")).resolves.toBeInstanceOf(Response);
  });

  it("drives a viem transport through the worker", async () => {
    const { worker, calls } = fakeWorker();
    const rpc = new PrivateRpc(cfg, { factory: async () => worker, directFetch: bootFetch().f });
    const { createPublicClient } = await import("viem");
    const { mainnet } = await import("viem/chains");
    const client = createPublicClient({ chain: mainnet, transport: rpc.transport({ kind: "public" }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(1n);
    expect(String(calls[0]!.input)).toMatch(/^https:\/\/rpc\.example\/?$/);
    expect(calls[0]!.init).not.toHaveProperty("url");
  });
});

describe("jsonRpcProvider", () => {
  it("posts JSON-RPC without credentials and unwraps the result", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" })));
    const p = jsonRpcProvider("https://boot.example", f as unknown as typeof fetch);
    expect(await p.request({ method: "eth_call", params: [{}] })).toBe("0xabc");
    expect(f.mock.calls[0]![1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("fails over to the next bootstrap RPC and reports the last error when all fail", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error("first down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0xaa36a7" })));
    const p = jsonRpcProvider(["https://a.example", "https://b.example"], f as unknown as typeof fetch);
    expect(await p.request({ method: "eth_chainId", params: [] })).toBe("0xaa36a7");
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://a.example", "https://b.example"]);

    const dead = vi.fn().mockRejectedValue(new Error("all down"));
    const q = jsonRpcProvider(["https://a.example", "https://b.example"], dead as unknown as typeof fetch);
    await expect(q.request({ method: "eth_chainId", params: [] })).rejects.toThrow("all down");
    expect(dead).toHaveBeenCalledTimes(2);
  });
});
