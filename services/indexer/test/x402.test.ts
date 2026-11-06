import { buildCatalog, type HarvestedOrg } from "@varada/cause-catalog";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import { catalogStoreOf } from "../src/api/catalog";
import { CIRCLE_FACILITATOR_URL, DEXTER_FACILITATOR_URL, readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { facilitatorsOf, floorPrice, paymentOptions, scopedFacilitator, toTokenUnits } from "../src/api/x402";
import { fixtureRepo } from "./api.fixtures";
import { REF, a, h, repo, stored } from "./agents.fixtures";

const BASE_TREASURY = a(0xba5e);
const ARC_TREASURY = a(0xa4c);
const OP_TREASURY = a(0x0b);
const ENV = {
  X402_ENABLED: "true",
  X402_BASE_PAY_TO: BASE_TREASURY,
  X402_BASE_FACILITATOR_URL: "https://facilitator.example",
  X402_ARC_PAY_TO: ARC_TREASURY,
  X402_OPTIMISM_PAY_TO: OP_TREASURY,
  X402_OPTIMISM_FACILITATOR_URL: "https://op-facilitator.example",
  X402_OPTIMISM_MIN_PRICE: "0.05",
};
const buyer = privateKeyToAccount(`0x${"42".repeat(32)}`);

function fakeFacilitator(networks: string[], settleAs?: (req: PaymentRequirements) => Record<string, unknown>) {
  const calls = { verify: [] as PaymentRequirements[], settle: [] as PaymentRequirements[], payloads: [] as PaymentPayload[] };
  const client: FacilitatorClient = {
    getSupported: async () => ({
      kinds: networks.map((network) => ({ x402Version: 2, scheme: "exact", network: network as `${string}:${string}` })),
      extensions: [],
      signers: {},
    }),
    verify: async (payload, req) => {
      calls.verify.push(req);
      calls.payloads.push(payload);
      return { isValid: true, payer: buyer.address };
    },
    settle: async (_payload, req) => {
      calls.settle.push(req);
      if (settleAs) return settleAs(req) as never;
      return { success: true, transaction: h(0x77), network: req.network, payer: buyer.address };
    },
  };
  return { client, calls };
}

const org = (i: number, over: Partial<HarvestedOrg>): HarvestedOrg => ({
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
const { catalog } = buildCatalog([
  org(1, { name: "City Food Bank" }),
  org(2, { name: "Rhino Rescue", nteeCode: "D31", country: "ZAF" }),
  org(3, { name: "Shelter House", nteeCode: "L41" }),
]);

function mk(env: Record<string, string> = ENV, withCatalog = false, arcSettle?: (req: PaymentRequirements) => Record<string, unknown>) {
  const config = readApiConfig(env);
  const r = fixtureRepo();
  const base = fakeFacilitator(["eip155:8453"]);
  // Circle's /supported also lists Base; scoping keeps Base on the Base facilitator.
  const arc = fakeFacilitator(["eip155:5042", "eip155:8453"], arcSettle);
  const op = fakeFacilitator(["eip155:10"]);
  const app = createApi({
    repo: r,
    search: { search: async () => [] },
    config,
    bus: new ActivityBus(() => r.listActivity({ limit: 100 }), 10_000),
    agents: repo(),
    reports: { get: async (ref) => (ref === REF ? stored : null) },
    catalog: catalogStoreOf(withCatalog ? catalog : null),
    x402Facilitators: [
      scopedFacilitator(base.client, "eip155:8453"),
      scopedFacilitator(arc.client, "eip155:5042"),
      scopedFacilitator(op.client, "eip155:10"),
    ],
  });
  return { app, base: base.calls, arc: arc.calls, op: op.calls };
}

/** Requests `path`, pays the challenge on `network` with a real EIP-3009 signature, retries. */
async function pay(app: ReturnType<typeof mk>["app"], path: string, network: string) {
  const first = await app.request(path);
  expect(first.status).toBe(402);
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  // @x402's client accepts only assets it knows by default; OP USDC has no default entry, so an
  // Optimism buyer must allow it explicitly (as a real buyer's wallet would).
  const opUsdc = { network: "eip155:10" as const, asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" };
  const client = registerExactEvmScheme(
    new x402Client((_v, accepts) => accepts.find((x) => x.network === network)!).setSpendControls({ allowedAssets: [opUsdc] }),
    { signer: buyer },
  );
  const payload = await client.createPaymentPayload(required);
  return app.request(path, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
}

describe("x402 paid routes", () => {
  it("challenges with Base, Arc and Optimism USDC, platform treasuries and per-network floors", async () => {
    const { app } = mk();
    const res = await app.request("/x402/v1/rankings/hunger/africa");
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts.map((x) => x.network)).toEqual(["eip155:8453", "eip155:5042", "eip155:10"]);
    const [base, arc, op] = required.accepts;
    expect(base).toMatchObject({ scheme: "exact", payTo: BASE_TREASURY, amount: "10000", extra: { name: "USD Coin", version: "2" } });
    expect(base!.asset.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(arc).toMatchObject({ scheme: "exact", payTo: ARC_TREASURY, amount: "10000", asset: "0x3600000000000000000000000000000000000000", extra: { name: "USDC", version: "2" } });
    // Optimism: explicit native USDC, and the $0.05 floor over the $0.01 price.
    expect(op).toMatchObject({ scheme: "exact", payTo: OP_TREASURY, amount: "50000", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", extra: { name: "USD Coin", version: "2" } });
  });

  it("serves the ranking after a Base payment and settles through the Base facilitator only", async () => {
    const { app, base, arc } = mk();
    const res = await pay(app, "/x402/v1/rankings/hunger/africa", "eip155:8453");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ region: "africa", verified: true, epoch: "12", agent: { ensName: "hunger.agent.varada.eth" } });
    expect(body.picks.map((p: { rank: number; name: string }) => [p.rank, p.name])).toEqual([[0, "Org A4"], [1, "Org A7"]]);
    expect(body.events[0].url).toBe("https://news.example/a");
    const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settled).toMatchObject({ success: true, transaction: h(0x77), network: "eip155:8453" });
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(base.settle).toHaveLength(1);
    expect(arc.verify).toHaveLength(0);
    // The signed authorization pays the platform treasury the quoted amount.
    const auth = (base.payloads[0]!.payload as { authorization: { to: string; value: string; from: string } }).authorization;
    expect(auth.to.toLowerCase()).toBe(BASE_TREASURY.toLowerCase());
    expect(auth.value).toBe("10000");
    expect(auth.from).toBe(buyer.address);
  });

  it("routes Arc and Optimism payments to their own facilitators", async () => {
    const { app, base, arc, op } = mk();
    const res = await pay(app, "/x402/v1/history/hunger", "eip155:5042");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.epochs[0]).toMatchObject({ epoch: "12", reportRef: REF });
    expect(body.epochs[0].regions[0].picks[0]).toMatchObject({ rank: 0, score: 90 });
    expect(arc.settle).toHaveLength(1);
    expect(arc.settle[0]!.amount).toBe("100000");
    // A stock client refuses the Optimism option: OP USDC is not one of its default assets.
    const first = await app.request("/x402/v1/history/hunger");
    const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
    const stock = registerExactEvmScheme(new x402Client((_v, accepts) => accepts.find((x) => x.network === "eip155:10")!), { signer: buyer });
    await expect(stock.createPaymentPayload({ ...required, accepts: required.accepts.filter((x) => x.network === "eip155:10") })).rejects.toThrow(/spendControls/);
    const viaOp = await pay(app, "/x402/v1/history/hunger", "eip155:10");
    expect(viaOp.status).toBe(200);
    expect(op.settle).toHaveLength(1);
    expect(op.settle[0]!.asset).toBe("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
    const auth = (op.payloads[0]!.payload as { authorization: { to: string; value: string } }).authorization;
    expect(auth.to.toLowerCase()).toBe(OP_TREASURY.toLowerCase());
    expect(auth.value).toBe("100000");
    expect(base.verify).toHaveLength(0);
  });

  it("withholds the paid response while Circle reports the settlement as pending", async () => {
    const pending = (req: PaymentRequirements) => ({
      success: true,
      payer: buyer.address,
      transaction: h(0x88),
      network: req.network,
      extensions: { "settlement-status": { status: "pending", paymentId: "p1", statusUrl: "https://api.circle.com/v1/facilitator/x402/status/p1" } },
    });
    const { app, arc } = mk(ENV, false, pending);
    const res = await pay(app, "/x402/v1/history/hunger", "eip155:5042");
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain(REF);
    // x402 retries a pending settlement once with the same payload, then gives up.
    expect(arc.settle.length).toBeGreaterThanOrEqual(1);
    expect(arc.settle.length).toBeLessThanOrEqual(2);
  });

  it("does not charge for a miss: a 4xx after verification cancels settlement", async () => {
    const { app, base } = mk();
    const res = await pay(app, "/x402/v1/rankings/hunger/oceania", "eip155:8453");
    expect(res.status).toBe(404);
    expect(base.verify).toHaveLength(1);
    expect(base.settle).toHaveLength(0);
    const unknown = await pay(app, "/x402/v1/newsletters/nope", "eip155:8453");
    expect(unknown.status).toBe(400);
    expect(base.settle).toHaveLength(0);
  });

  it("serves the newsletter archive", async () => {
    const { app } = mk();
    const res = await pay(app, "/x402/v1/newsletters/hunger", "eip155:8453");
    const body = await res.json();
    expect(body.issues[0]).toMatchObject({ title: "Hunger: week 12", regions: [{ region: "africa", newsletter: "Africa section" }] });
  });

  it("lists prices for free and answers 503 for the export without a catalogue", async () => {
    const { app, base } = mk();
    const list = await app.request("/x402/v1");
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.routes.map((r: { route: string }) => r.route)).toContain("GET /x402/v1/catalog/export");
    expect(body.routes[0].accepts).toHaveLength(3);
    const exp = await pay(app, "/x402/v1/catalog/export", "eip155:8453");
    expect(exp.status).toBe(503);
    expect(base.settle).toHaveLength(0);
  });

  it("exports the classified catalogue with filters and paging", async () => {
    const { app } = mk(ENV, true);
    const all = await (await pay(app, "/x402/v1/catalog/export?limit=2", "eip155:8453")).json();
    expect(all).toMatchObject({ total: 3, offset: 0, limit: 2, root: catalog.meta.root });
    expect(all.items).toHaveLength(2);
    const wild = await (await pay(app, "/x402/v1/catalog/export?category=endangered-species&region=africa", "eip155:8453")).json();
    expect(wild.items.map((o: { name: string }) => o.name)).toEqual(["Rhino Rescue"]);
    expect((await pay(app, "/x402/v1/catalog/export?category=nope", "eip155:8453")).status).toBe(400);
  });

  it("exposes the payment headers to browsers and allows the signature header", async () => {
    const { app } = mk();
    const pre = await app.request("/x402/v1/rankings/hunger/africa", {
      method: "OPTIONS",
      headers: { Origin: "https://varada.com", "Access-Control-Request-Headers": "PAYMENT-SIGNATURE" },
    });
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("PAYMENT-SIGNATURE");
    const res = await app.request("/x402/v1/rankings/hunger/africa", { headers: { Origin: "https://varada.com" } });
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
  });

  it("is absent when disabled, and offers only the networks with a treasury", async () => {
    const off = mk({});
    expect((await off.app.request("/x402/v1/rankings/hunger/africa")).status).toBe(404);
    expect((await off.app.request("/x402/v1")).status).toBe(404);
    const { X402_ARC_PAY_TO: _a, X402_OPTIMISM_PAY_TO: _o, ...baseOnly } = ENV;
    const res = await mk(baseOnly).app.request("/x402/v1/history/hunger");
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).accepts.map((x) => x.network)).toEqual(["eip155:8453"]);
  });

  it("validates the configuration", () => {
    expect(() => readApiConfig({ X402_ENABLED: "true" })).toThrow(/X402_BASE_PAY_TO, X402_ARC_PAY_TO or X402_OPTIMISM_PAY_TO/);
    // Optimism defaults to Dexter; Arc without CIRCLE_API_KEY uses Circle's keyless trial.
    expect(readApiConfig({ X402_OPTIMISM_PAY_TO: OP_TREASURY }).x402.networks[0]!.facilitator).toEqual({ url: DEXTER_FACILITATOR_URL, token: undefined });
    expect(readApiConfig({ X402_ARC_PAY_TO: ARC_TREASURY }).x402.networks[0]!.facilitator).toEqual({ url: CIRCLE_FACILITATOR_URL, token: undefined });
    expect(() => readApiConfig({ ...ENV, X402_PRICE_RANKINGS: "1e3" })).toThrow();
    expect(() => readApiConfig({ ...ENV, X402_ARC_NETWORK: "eip155:8453" })).toThrow(/distinct/);
    expect(() => readApiConfig({ ...ENV, X402_ARC_NETWORK: "arc" })).toThrow(/CAIP-2/);
    // Mainnet settlement is gone: its old variables configure nothing.
    expect(readApiConfig({ X402_ENABLED: "true", X402_BASE_PAY_TO: BASE_TREASURY, X402_MAINNET_PAY_TO: a(0x0e7) }).x402.networks.map((n) => n.network)).toEqual(["eip155:8453"]);
    const arc = readApiConfig({ X402_ARC_PAY_TO: ARC_TREASURY, CIRCLE_API_KEY: "k" }).x402.networks[0]!;
    expect(arc).toMatchObject({ name: "arc", network: "eip155:5042", facilitator: { url: CIRCLE_FACILITATOR_URL, token: "k" } });
    expect(floorPrice("0.01", "0.50")).toBe("0.50");
    expect(floorPrice("2.5", "0.50")).toBe("2.5");
    expect(floorPrice("0.01", undefined)).toBe("0.01");
    expect(toTokenUnits("0.01", 6)).toBe("10000");
    expect(toTokenUnits("1.5", 18)).toBe("1500000000000000000");
    expect(paymentOptions(readApiConfig(ENV).x402, "catalog").map((o) => o.price)).toEqual([
      "$0.50",
      "$0.50",
      { amount: "500000", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", extra: { name: "USD Coin", version: "2" } },
    ]);
    expect(facilitatorsOf(readApiConfig(ENV).x402)).toHaveLength(3);
  });
});

describe("scopedFacilitator", () => {
  const req = { scheme: "exact", network: "eip155:5042" } as unknown as PaymentRequirements;
  const base = { success: true, transaction: h(0x99), network: "eip155:5042", payer: buyer.address };
  const wrap = (settle: Record<string, unknown>) =>
    scopedFacilitator(
      {
        verify: async () => ({ isValid: true }),
        settle: async () => settle as never,
        getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:5042" }, { x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }),
      },
      "eip155:5042",
    );

  it("claims only its own network", async () => {
    expect((await wrap(base).getSupported()).kinds.map((k) => k.network)).toEqual(["eip155:5042"]);
  });

  it("passes a final settlement and turns pending or hashless successes into settlement_pending", async () => {
    const p = {} as PaymentPayload;
    expect(await wrap(base).settle(p, req)).toEqual(base);
    expect(await wrap({ ...base, extensions: { "settlement-status": { status: "settled" } } }).settle(p, req)).toMatchObject({ success: true });
    expect(await wrap({ ...base, extensions: { "settlement-status": { status: "pending" } } }).settle(p, req)).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: h(0x99) });
    expect(await wrap({ ...base, transaction: "" }).settle(p, req)).toMatchObject({ success: false, errorReason: "settlement_pending" });
    const failed = { success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: "eip155:5042" };
    expect(await wrap(failed).settle(p, req)).toEqual(failed);
  });
});
