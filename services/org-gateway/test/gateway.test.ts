import { describe, expect, it, vi } from "vitest";
import { buildCatalog, labelhash, shardOf, type HarvestedOrg, type NameOrgIds } from "@varada/cause-catalog";
import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";
import { createApp } from "../src/app.js";
import { createL2Proxy } from "../src/l2proxy.js";
import { decodeCcipResponse, encodeCcipRequest, encodeCcipResponse } from "../src/ccip.js";
import { createRootReader, noRoot, type RootReader } from "../src/root.js";
import { Build, BuildSet } from "../src/store.js";

const RESOLVER = "0x1111111111111111111111111111111111111111";

function org(n: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    ein: String(100000000 + n),
    name: `Org ${n}`,
    description: null,
    nteeCode: "K31",
    country: "USA",
    state: "NY",
    isCompliant: true,
    claimed: false,
    donationsReceived: 0,
    mainnetAddress: "0x000000000000000000000000000000000000beef",
    ...over,
  };
}

function buildOf(orgs: HarvestedOrg[], builtAt: string) {
  return new Build(buildCatalog(orgs, { now: new Date(builtAt) }).catalog, builtAt);
}

/** VaradaOrgResolver's callback, re-implemented with viem: shard leaf proof, then entry lookup. */
function resolveLikeSolidity(root: Hex, hash: Hex, response: Hex): NameOrgIds | null {
  const { root: r, shard, entries, proof } = decodeCcipResponse(response);
  if (r.toLowerCase() !== root.toLowerCase()) throw new Error("wrong root");
  if (Number(BigInt(hash) >> 244n) !== shard) throw new Error("wrong shard");
  const b32 = { type: "bytes32" } as const;
  const eh = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [b32, b32, b32, b32] }], [entries as unknown as [Hex, Hex, Hex, Hex][]]));
  let node = keccak256(keccak256(encodeAbiParameters([{ type: "uint256" }, b32], [BigInt(shard), eh])));
  for (const p of proof) node = BigInt(node) < BigInt(p) ? keccak256(concat([node, p])) : keccak256(concat([p, node]));
  if (node.toLowerCase() !== root.toLowerCase()) throw new Error("invalid proof");
  const e = entries.find((x) => x[0].toLowerCase() === hash.toLowerCase());
  return e ? { eth: e[1], optimism: e[2], base: e[3] } : null;
}

const fixedRoot = (r: Hex | null): RootReader => ({ get: async () => r });
const req = (label: string) => encodeCcipRequest(shardOf(labelhash(label)));
const dataOf = async (res: Response) => ((await res.json()) as { data: Hex }).data;

const ORGS = [
  org(1, { name: "Hope Fund", claimed: true }),
  org(2, { name: "Hope Fund", nteeCode: "B20" }),
  org(3, { name: "River Food Bank", nteeCode: "K31", lifetimeContributionsUsdc: String(50_000 * 1e6) }),
];

describe("CCIP endpoint", () => {
  const build = buildOf(ORGS, "2026-11-07T00:00:00.000Z");
  const app = createApp({ builds: () => new BuildSet([build]), root: noRoot, resolver: RESOLVER });

  it("answers abi.encode(root, shard, entries, proof) that resolves the way the resolver does", async () => {
    const res = await app.request(`/ccip/${RESOLVER}/${req("hope-fund-2")}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const data = await dataOf(res);
    expect(decodeCcipResponse(data).root).toBe(build.namesRoot);
    const org2 = build.catalog.orgs.find((o) => o.label === "hope-fund-2")!;
    expect(resolveLikeSolidity(build.namesRoot, labelhash("hope-fund-2"), data)).toEqual({ eth: org2.orgId, optimism: org2.orgId, base: org2.orgId });
  });

  it("serves the sender-less Swarm-style path with the same bytes as the static export", async () => {
    const a = await dataOf(await app.request(`/ccip/${req("river-food-bank")}.json`));
    const b = await dataOf(await app.request(`/ccip/${RESOLVER}/${req("river-food-bank")}.json`));
    expect(a).toBe(b);
    expect(a).toBe(encodeCcipResponse(build.namesRoot, build.names.shardProof(shardOf(labelhash("river-food-bank")))!));
    expect(await (await app.request("/l2-fallback.json")).json()).toEqual({ data: "0x" });
  });

  it("proves absence for an unknown label", async () => {
    const data = await dataOf(await app.request(`/ccip/${req("missing-charity")}.json`));
    expect(resolveLikeSolidity(build.namesRoot, labelhash("missing-charity"), data)).toBeNull();
  });

  it("accepts POST {sender, data} and refuses other senders, bad data and out-of-range shards", async () => {
    const body = JSON.stringify({ sender: RESOLVER, data: req("river-food-bank") });
    const ok = await app.request("/ccip", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(resolveLikeSolidity(build.namesRoot, labelhash("river-food-bank"), await dataOf(ok))).not.toBeNull();
    const other = await app.request(`/ccip/0x2222222222222222222222222222222222222222/${req("hope-fund")}.json`);
    expect(other.status).toBe(404);
    expect((await app.request(`/ccip/${RESOLVER}/0x1234.json`)).status).toBe(400);
    expect((await app.request(`/ccip/${encodeCcipRequest(4096)}.json`)).status).toBe(400);
  });

  it("serves the build whose root matches the resolver's on-chain root, else the newest", async () => {
    const old = buildOf(ORGS.slice(0, 2), "2026-11-01T00:00:00.000Z");
    const set = () => new BuildSet([old, build]);
    const q = `/ccip/${req("hope-fund")}.json`;
    const rootOf = async (r: Hex | null) => decodeCcipResponse(await dataOf(await createApp({ builds: set, root: fixedRoot(r) }).request(q))).root;
    expect(await rootOf(old.namesRoot)).toBe(old.namesRoot);
    expect(await rootOf(build.namesRoot)).toBe(build.namesRoot);
    expect(await rootOf(`0x${"ab".repeat(32)}`)).toBe(build.namesRoot);
    expect(await rootOf(null)).toBe(build.namesRoot);
  });
});

describe("L2 proof proxy", () => {
  const build = buildOf(ORGS, "2026-11-07T00:00:00.000Z");
  const proof = `0x${"11".repeat(64)}`;

  it("returns the first upstream proof, and 0x when every upstream fails", async () => {
    const good = vi.fn(async (u: string) =>
      u.includes("ok") ? new Response(JSON.stringify({ data: proof })) : new Response("nope", { status: 500 }),
    );
    const app = createApp({
      builds: () => new BuildSet([build]),
      root: noRoot,
      l2: createL2Proxy({ upstreams: ["https://bad.invalid", "https://ok.invalid"], fetch: good as never, budgetMs: 1_000 }),
    });
    const q = `/l2/${RESOLVER}/0x${"ab".repeat(4)}.json`;
    expect(await (await app.request(q)).json()).toEqual({ data: proof });
    const down = createApp({
      builds: () => new BuildSet([build]),
      root: noRoot,
      l2: createL2Proxy({ upstreams: ["https://bad.invalid"], fetch: (async () => new Response("x", { status: 503 })) as never }),
    });
    expect(await (await down.request(q)).json()).toEqual({ data: "0x" });
    expect((await down.request(`/l2/not-an-address/0x00.json`)).status).toBe(400);
  });
});

describe("L2 proxy budget and fallback", () => {
  const build = buildOf(ORGS, "2026-11-07T00:00:00.000Z");
  it("answers 0x within the budget when an upstream hangs, and refuses other senders", async () => {
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    const app = createApp({
      builds: () => new BuildSet([build]),
      root: noRoot,
      resolver: RESOLVER,
      l2: createL2Proxy({ upstreams: ["https://slow.invalid"], fetch: hang as never, budgetMs: 200 }),
    });
    const t = Date.now();
    expect(await (await app.request(`/l2/${RESOLVER}/0x31c1980f.json`)).json()).toEqual({ data: "0x" });
    expect(Date.now() - t).toBeLessThan(1500);
    const other = "0x2222222222222222222222222222222222222222";
    expect((await app.request(`/l2/${other}/0x31c1980f.json`)).status).toBe(404);
  });
  it("serves the last-resort fallback in every form", async () => {
    const app = createApp({ builds: () => new BuildSet([build]), root: noRoot });
    for (const r of [
      await app.request("/l2-fallback.json?d=0x31c1980f"),
      await app.request(`/l2-fallback/${RESOLVER}/0x31c1980f.json`),
      await app.request("/l2-fallback", { method: "POST", body: JSON.stringify({ sender: RESOLVER, data: "0x31c1980f" }) }),
    ]) {
      expect(await r.json()).toEqual({ data: "0x" });
    }
  });
});

describe("org API", () => {
  const build = buildOf(ORGS, "2026-11-07T00:00:00.000Z");
  const app = createApp({ builds: () => new BuildSet([build]), root: noRoot });

  it("lists by rank with filters and a cursor", async () => {
    const all = (await (await app.request("/orgs?limit=2")).json()) as { orgs: { label: string; rank: number }[]; total: number; nextCursor: string | null };
    expect(all.total).toBe(3);
    expect(all.orgs.map((o) => o.label)).toEqual(["river-food-bank", "hope-fund"]);
    expect(all.nextCursor).toBe("2");
    const rest = (await (await app.request("/orgs?limit=2&cursor=2")).json()) as { orgs: { label: string }[]; nextCursor: string | null };
    expect(rest.orgs.map((o) => o.label)).toEqual(["hope-fund-2"]);
    expect(rest.nextCursor).toBeNull();
    const q = (await (await app.request("/orgs?q=river")).json()) as { total: number };
    expect(q.total).toBe(1);
    const byCat = (await (await app.request("/orgs?category=hunger&sort=name")).json()) as { orgs: { label: string }[] };
    expect(byCat.orgs.every((o) => o.label !== "hope-fund-2")).toBe(true);
    expect((await app.request("/orgs?sort=bogus")).status).toBe(400);
  });

  it("returns one org with its address on chains 1, 10 and 8453", async () => {
    const res = await app.request("/orgs/hope-fund");
    const o = (await res.json()) as { ensName: string; address: string; orgId: string; chains: { chainId: number; address: string; orgId: string; source: string }[] };
    expect(o.ensName).toBe("hope-fund.org.varada.eth");
    expect(o.chains.map((c) => [c.chainId, c.source, c.orgId])).toEqual([1, 10, 8453].map((id) => [id, "default", o.orgId]));
    expect(new Set(o.chains.map((c) => c.address))).toEqual(new Set([o.address]));
    expect((await app.request("/orgs/nope")).status).toBe(404);
  });

  it("reports builds on /health", async () => {
    const h = (await (await app.request("/health")).json()) as { ok: boolean; serving: string };
    expect(h).toMatchObject({ ok: true, serving: build.namesRoot });
  });
});

describe("root reader", () => {
  it("caches root() for the ttl and keeps the last value on RPC errors", async () => {
    let t = 0;
    const readContract = vi.fn().mockResolvedValueOnce(`0x${"01".repeat(32)}`).mockRejectedValueOnce(new Error("rpc down"));
    const r = createRootReader({ client: { readContract } as never, resolver: RESOLVER, ttlMs: 60_000, now: () => t });
    expect(await r.get()).toBe(`0x${"01".repeat(32)}`);
    t = 30_000;
    await r.get();
    expect(readContract).toHaveBeenCalledTimes(1);
    t = 61_000;
    expect(await r.get()).toBe(`0x${"01".repeat(32)}`);
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
