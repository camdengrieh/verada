import { buildCatalog, type HarvestedOrg } from "@varada/cause-catalog";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { catalogStoreOf } from "../src/api/catalog";
import { readApiConfig, DEFAULT_DONOR_EXCLUDE } from "../src/api/config";
import {
  type CoinDonationRow,
  type DonorsRepo,
  type WalletDonationRow,
  donorWindow,
  inCause,
  rankBy,
  varadaNameLookup,
} from "../src/api/donors";
import { createApi } from "../src/api/routes";
import type { Repo } from "../src/api/types";
import { createFakeContext } from "./fakeDb";

declare global {
  interface Response {
    // biome-ignore lint/suspicious/noExplicitAny: test convenience for JSON bodies
    json(): Promise<any>;
  }
}

const org = (i: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(400000000 + i),
  name: `Org ${i}`,
  description: null,
  nteeCode: "K31",
  country: "USA",
  state: "NY",
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});
// Two hunger orgs (one in Africa) and a homelessness org.
const { catalog } = buildCatalog([
  org(1, { name: "City Food Bank" }),
  org(2, { name: "Sahel Food Relief", country: "NER" }),
  org(3, { name: "Shelter House", nteeCode: "L41" }),
]);
const [food, sahel, shelter] = catalog.orgs.map((o) => o.causeId as Hex);
const store = catalogStoreOf(catalog);
const orgOf = (id: Hex) => store.causes([id])?.[0];

const A = "0x00000000000000000000000000000000000000a1" as Hex;
const B = "0x00000000000000000000000000000000000000b2" as Hex;
const C = "0x00000000000000000000000000000000000000c3" as Hex;
const T1 = "0x00000000000000000000000000000000000000d1" as Hex;
const T2 = "0x00000000000000000000000000000000000000d2" as Hex;
const ENDAOMENT_DAO = DEFAULT_DONOR_EXCLUDE[1] as Hex;

const coins: CoinDonationRow[] = [
  { token: T1, causeId: food!, amount: 4_000_000n, donations: 1 },
  { token: T1, causeId: sahel!, amount: 1_000_000n, donations: 1 },
  { token: T2, causeId: food!, amount: 3_000_000n, donations: 2 },
  { token: T2, causeId: shelter!, amount: 50_000_000n, donations: 1 },
];
const wallets: WalletDonationRow[] = [
  { donor: A, causeId: food!, amount: 2_000_000n, donations: 1 },
  { donor: B, causeId: sahel!, amount: 7_000_000n, donations: 3 },
  { donor: C, causeId: shelter!, amount: 99_000_000n, donations: 1 },
  { donor: ENDAOMENT_DAO, causeId: food!, amount: 500_000_000n, donations: 9 },
];

describe("donor ranking", () => {
  it("keeps only the cause's catalogue orgs, optionally one region", () => {
    expect(inCause(wallets, orgOf, "hunger").map((r) => r.donor)).toEqual([A, B, ENDAOMENT_DAO]);
    expect(inCause(wallets, orgOf, "hunger", "africa").map((r) => r.donor)).toEqual([B]);
    expect(inCause(wallets, orgOf, "homelessness").map((r) => r.donor)).toEqual([C]);
  });

  it("sums per donor across orgs, largest first, and drops excluded addresses", () => {
    const ranked = rankBy(inCause(coins, orgOf, "hunger"), (r) => r.token);
    expect(ranked).toEqual([
      { key: T1, donated: 5_000_000n, donations: 2, orgs: 2 },
      { key: T2, donated: 3_000_000n, donations: 2, orgs: 1 },
    ]);
    const w = rankBy(inCause(wallets, orgOf, "hunger"), (r) => r.donor, new Set([ENDAOMENT_DAO]));
    expect(w.map((r) => r.key)).toEqual([B, A]);
  });

  it("windows an epoch through the clock, else the trailing days", () => {
    const clock = { epochZeroStart: 1000n, epochLength: 100n };
    expect(donorWindow({ epoch: 3n }, clock, 5000n)).toEqual({ from: 1300n, to: 1400n, epoch: 3n });
    expect(donorWindow({ epoch: 3n }, null, 5000n)).toBeNull();
    expect(donorWindow({ days: 2 }, null, 1_000_000n)).toEqual({ from: 1_000_000n - 172_800n, to: 1_000_001n, epoch: null });
  });
});

describe("varada.eth names for wallets", () => {
  it("keeps only parent subnames, caches answers and retries failures", async () => {
    const calls: string[] = [];
    let fail = true;
    const client = {
      getEnsName: async ({ address }: { address: Hex }) => {
        calls.push(address);
        if (address === C && fail) throw new Error("rpc down");
        return ({ [A]: "Alice.varada.eth", [B]: "bob.eth", [C]: "carol.varada.eth" } as Record<string, string>)[address] ?? null;
      },
    };
    let t = 0;
    const names = varadaNameLookup(client as never, "varada.eth", { now: () => t });
    const first = await names.names([A, B, C]);
    expect([...first.entries()]).toEqual([[A, "alice.varada.eth"]]);
    fail = false;
    const second = await names.names([A, B, C]);
    expect(second.get(C)).toBe("carol.varada.eth");
    // A and B were cached; C was retried after its failure.
    expect(calls.filter((a) => a === A)).toHaveLength(1);
    expect(calls.filter((a) => a === C)).toHaveLength(2);
    t = 2 * 60 * 60 * 1000;
    await names.names([A]);
    expect(calls.filter((a) => a === A)).toHaveLength(2);
  });

  it("answers no names without a client", async () => {
    expect((await varadaNameLookup(null, "varada.eth").names([A])).size).toBe(0);
  });
});

describe("GET /api/agents/:label/donors", () => {
  const NOW = 10_000_000;
  const seen: { from: bigint; to: bigint }[] = [];
  const repo: DonorsRepo = {
    coins: async (from, to) => {
      seen.push({ from, to });
      return coins;
    },
    wallets: async () => wallets,
    tokens: async (addrs) =>
      addrs.map((a) => ({ address: a, name: a === T1 ? "Bread" : "Soup", symbol: a === T1 ? "BREAD" : "SOUP", label: a === T1 ? "bread" : null })),
    clock: async () => ({ epochZeroStart: 1_000_000n, epochLength: 604_800n }),
  };
  const mk = (over: Partial<Parameters<typeof createApi>[0]> = {}) =>
    createApi({
      repo: {} as Repo,
      search: { search: async () => [] },
      config: readApiConfig({}),
      catalog: store,
      donors: repo,
      names: { names: async (a) => new Map(a.filter((x) => x === A).map((x) => [x, "alice.varada.eth"])) },
      now: () => NOW * 1000,
      ...over,
    });

  it("ranks coins and wallets for the agent's cause, with varada.eth names", async () => {
    const r = await (await mk().request("/api/agents/hunger/donors")).json();
    expect(r).toMatchObject({ label: "hunger", category: "hunger", region: null, window: { epoch: null, to: String(NOW + 1) } });
    expect(r.coins).toEqual([
      { token: T1, name: "Bread", symbol: "BREAD", ensName: "bread.varada.eth", donated: "5000000", donations: 2, orgs: 2 },
      { token: T2, name: "Soup", symbol: "SOUP", ensName: null, donated: "3000000", donations: 2, orgs: 1 },
    ]);
    // Endaoment's own DAO is excluded by default; the homelessness donor is another cause.
    expect(r.wallets).toEqual([
      { address: B, ensName: null, donated: "7000000", donations: 3, orgs: 1 },
      { address: A, ensName: "alice.varada.eth", donated: "2000000", donations: 1, orgs: 1 },
    ]);
    expect(r.totals).toEqual({ coins: { donated: "8000000", donors: 2 }, wallets: { donated: "9000000", donors: 2 } });
  });

  it("filters by region, limits, and windows an epoch", async () => {
    const r = await (await mk().request("/api/agents/hunger/donors?region=africa&limit=1&epoch=2")).json();
    expect(r.region).toBe("africa");
    expect(r.coins.map((c: { token: string }) => c.token)).toEqual([T1]);
    expect(r.wallets.map((w: { address: string }) => w.address)).toEqual([B]);
    expect(r.window).toEqual({ from: String(1_000_000 + 2 * 604_800), to: String(1_000_000 + 3 * 604_800), epoch: "2" });
    expect(seen.at(-1)).toEqual({ from: 1_000_000n + 2n * 604_800n, to: 1_000_000n + 3n * 604_800n });
  });

  it("validates input and answers 503 without its sources", async () => {
    expect((await mk().request("/api/agents/nope/donors")).status).toBe(400);
    expect((await mk().request("/api/agents/hunger/donors?region=mars")).status).toBe(400);
    expect((await mk().request("/api/agents/hunger/donors?limit=0")).status).toBe(400);
    expect((await mk({ donors: undefined }).request("/api/agents/hunger/donors")).status).toBe(503);
    expect((await mk({ catalog: catalogStoreOf(null) }).request("/api/agents/hunger/donors")).status).toBe(503);
  });

  it("honours DONOR_EXCLUDE=none", async () => {
    const r = await (await mk({ config: readApiConfig({ DONOR_EXCLUDE: "none" }) }).request("/api/agents/hunger/donors")).json();
    expect(r.wallets[0].address).toBe(ENDAOMENT_DAO);
    expect(() => readApiConfig({ DONOR_EXCLUDE: "0x12" })).toThrow(/not an address/);
  });
});

describe("Endaoment donation handler", () => {
  const ORG_ID = `0x${"11".repeat(32)}` as Hex;
  const ORG = "0x00000000000000000000000000000000000000f1";
  const FAKE = "0x00000000000000000000000000000000000000f2";
  const FACTORY = "0x10fD9348136dCea154F752fe0B6dB45Fc298A589";

  it("records real org donations, resolves factory donors to the sender and skips look-alikes", async () => {
    const { onEntityDonationReceived } = await import("../src/handlers/endaoment");
    const schema = await import("ponder:schema");
    let reads = 0;
    const h = createFakeContext(
      new Map<object, string[]>([
        [schema.endaomentEntity, ["address"]],
        [schema.orgDonation, ["id"]],
      ]),
      async ({ functionName, address }) => {
        reads++;
        if (functionName === "orgId") return ORG_ID; // the look-alike claims the same org id
        if (functionName === "computeOrgAddress") return ORG.toUpperCase().replace("0X", "0x");
        throw new Error(`unexpected ${address}`);
      },
    );
    const run = (emitter: string, args: object, id: string, txFrom: string = A) =>
      onEntityDonationReceived({
        event: { args, id, log: { address: emitter }, block: { timestamp: 100n, number: 7n }, transaction: { hash: `0x${id.padStart(64, "0")}`, from: txFrom } },
        context: h.context,
      } as never);
    const base = { tokenIn: "0x00000000000000000000000000000000000000ee", amountIn: 10n, amountReceived: 9n, amountFee: 1n };
    await run(ORG, { ...base, from: B, to: ORG }, "1");
    await run(ORG, { ...base, from: FACTORY, to: ORG }, "2", C);
    await run(FAKE, { ...base, from: B, to: FAKE }, "3");
    await run(ORG, { ...base, from: B, to: FAKE }, "4");
    const rows = h.rows(schema.orgDonation);
    expect(rows.map((r) => [r.donor, r.via, r.amount])).toEqual([
      [B, B, 9n],
      [C, FACTORY.toLowerCase(), 9n],
    ]);
    expect(rows[0]?.orgId).toBe(ORG_ID);
    // Each emitter is checked once (two reads each), including the rejected look-alike.
    expect(reads).toBe(4);
    expect(h.rows(schema.endaomentEntity).map((e) => [e.address, e.orgId])).toEqual([
      [ORG, ORG_ID],
      [FAKE, null],
    ]);
  });
});
