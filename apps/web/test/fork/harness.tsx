/**
 * Shared setup for the fork-backed flow tests (`*.fork.test.tsx`). They run the app's real
 * providers, wagmi config, private-RPC client, hooks and components against an anvil fork of
 * mainnet that has Varada deployed. Skipped unless VARADA_FORK_RPC (the node), VARADA_FORK_FIXTURE
 * (JSON with the deployed addresses) and VARADA_FORK_KEY_FILE (a file holding the test wallet's private
 * key, a fresh key whose address controls the fixture token) are set, so the default `vitest run`
 * stays hermetic. Run with `pnpm --filter @varada/web test:fork`: the files share one node and revert
 * it to their starting state when they finish, so they must not run in parallel.
 *
 * What is real: contracts, chain state, wagmi, the wallet connection (EIP-6963), the private-RPC
 * client (its anon worker is replaced by a fetch that goes straight to the fork), react-query,
 * every component. What is faked: the anon network itself, the wallet (a test EIP-1193 provider),
 * and the indexer (unreachable on purpose, so the app takes its read-from-chain paths).
 */
import { render, type RenderResult } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactNode } from "react";
import { concatHex, createPublicClient, encodeAbiParameters, http, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { CATEGORIES, REGIONS } from "@varada/sdk";
import { causeCatalogAbi } from "@varada/sdk/abis";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll } from "vitest";
import { Providers } from "@/components/providers";
import { createTestWallet, type TestWallet } from "./test-wallet";

export const FORK_RPC = process.env.VARADA_FORK_RPC ?? "";
export const FORK_FIXTURE = process.env.VARADA_FORK_FIXTURE ?? "";
export const forkEnabled = Boolean(FORK_RPC && FORK_FIXTURE);
/** A fresh key, never an anvil dev account. */
export const TEST_KEY = (process.env.VARADA_FORK_KEY_FILE ? readFileSync(process.env.VARADA_FORK_KEY_FILE, "utf8").trim() : "0x") as Hex;

export interface Fixture {
  me: Address;
  factory: Address;
  epochGovernor: Address;
  takeoverGovernor: Address;
  profileRegistry: Address;
  curatorRegistry: Address;
  causeCatalog: Address;
  mockScheme: Address;
  token: Address;
  vault: Address;
  agentId: number;
  deployBlock: number;
}

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FORK_FIXTURE, "utf8")) as Fixture;
}

export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export const chain = forkEnabled ? createPublicClient({ chain: mainnet, transport: http(FORK_RPC) }) : (undefined as never);

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(FORK_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Sets a USDC balance directly in storage (FiatToken keeps balances in the mapping at slot 9). */
export async function setUsdc(account: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 9n]));
  await rpc("anvil_setStorageAt", [USDC, slot, toHex(amount, { size: 32 })]);
}

/** Points the app's build-time env at the fork. The runtime config falls back to these (no config.json). */
export function applyForkEnv(f: Fixture, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    NEXT_PUBLIC_CHAIN_ID: "1",
    NEXT_PUBLIC_RPC_URL: FORK_RPC,
    NEXT_PUBLIC_PRIVATE_RPC_URLS: FORK_RPC,
    // Nothing listens here: the app has to read from the chain.
    NEXT_PUBLIC_INDEXER_URLS: "http://127.0.0.1:9",
    NEXT_PUBLIC_FACTORY_ADDRESS: f.factory,
    NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK: String(f.deployBlock),
    NEXT_PUBLIC_GOVERNOR_ADDRESS: f.epochGovernor,
    NEXT_PUBLIC_PROFILE_REGISTRY_ADDRESS: f.profileRegistry,
    NEXT_PUBLIC_VOTING_SCHEME_ADDRESS: f.mockScheme,
    NEXT_PUBLIC_TAKEOVER_GOVERNOR_ADDRESS: f.takeoverGovernor,
    NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS: f.curatorRegistry,
    ...extra,
  };
  Object.assign(process.env, env);
}

/**
 * The anon-rpc browser harness drives an iframe and a worker; here its fetch goes straight to the
 * fork. Call from the test file (vi.mock is hoisted there): `vi.mock("@anon-rpc/browser-harness", fakeAnonHarness)`.
 */
export function fakeAnonHarness() {
  return {
    AnonRpcWorker: class {
      ready = Promise.resolve();
      async fetch(input: string | URL | Request, init: RequestInit & { anonOptions?: unknown } = {}) {
        const rest = { ...init };
        delete rest.anonOptions; // the isolation key means nothing to a direct fetch
        return fetch(input, rest);
      }
      close() {}
    },
  };
}

/** A wallet on the fork, announced over EIP-6963. Funded with ETH for gas. */
export async function newWallet(opts: { chainId?: number } = {}): Promise<TestWallet> {
  const wallet = createTestWallet({ rpcUrl: FORK_RPC, privateKey: TEST_KEY, chainId: opts.chainId });
  await rpc("anvil_setBalance", [wallet.address, "0x3635C9ADC5DEA00000"]);
  wallet.announce();
  return wallet;
}

export function renderApp(ui: ReactNode): RenderResult {
  return render(<Providers>{ui}</Providers>);
}

/** Reverts the node to its state before the test file ran, so the file can run again. */
export function useChainSnapshot() {
  let id: string | undefined;
  beforeAll(async () => {
    id = await rpc<string>("evm_snapshot");
  }, 60_000);
  afterAll(async () => {
    if (id) await rpc("evm_revert", [id]);
  }, 60_000);
}

/** The fixture catalogue: two orgs in the hunger x first-region bucket (bucket 32), as published by the fixture script. */
export const ORG_IDS = [stringToHex("999000111", { size: 32 }), stringToHex("200049703", { size: 32 })] as const;
export const ORG_NAMES = ["Fork Hunger Relief", "Wikimedia Fixture"] as const;
const BUCKET = 32;

export const causeIdOf = (orgId: Hex): Hex => keccak256(encodeAbiParameters([{ type: "bytes32" }], [orgId]));

/**
 * A minimal indexer: only the catalogue endpoints (org lookup, entries with Merkle proofs, search,
 * pool size). Every other route answers 503, so the app takes its read-from-chain paths.
 */
export async function startFixtureIndexer(f: Fixture): Promise<{ server: Server; url: string }> {
  const leaves = await Promise.all(
    ORG_IDS.map((orgId, i) => chain.readContract({ address: f.causeCatalog, abi: causeCatalogAbi, functionName: "leafHash", args: [BUCKET, i, orgId] })),
  );
  const [a, b] = leaves as [Hex, Hex];
  const root = keccak256(a.toLowerCase() < b.toLowerCase() ? concatHex([a, b]) : concatHex([b, a]));
  const proofOf = (i: number): Hex[] => [leaves[1 - i] as Hex];
  const org = (i: number) => ({
    orgId: ORG_IDS[i],
    causeId: causeIdOf(ORG_IDS[i]!),
    ein: null,
    name: ORG_NAMES[i],
    country: "US",
    state: null,
    nteeCode: null,
    categories: [CATEGORIES.find((c) => c.bit === 2)!.slug],
    regions: [REGIONS[0]!.slug],
  });
  const entry = (i: number) => ({ bucket: BUCKET, index: i, orgId: ORG_IDS[i], proof: proofOf(i) });
  const indexOfId = (id: string) => ORG_IDS.findIndex((o) => [o, causeIdOf(o)].some((x) => x.toLowerCase() === id.toLowerCase()));

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const m = /^\/api\/catalog\/orgs\/(.+)$/.exec(u.pathname);
    if (m) {
      const i = indexOfId(decodeURIComponent(m[1]!));
      return i < 0 ? send(404, { error: "not found" }) : send(200, { org: org(i), entries: [entry(i)] });
    }
    if (u.pathname === "/api/catalog/entries") {
      const at = (u.searchParams.get("at") ?? "").split(",").map((p) => p.split(":").map(Number) as [number, number]);
      return send(200, { root, items: at.map(([, idx]) => entry(idx!)) });
    }
    if (u.pathname === "/api/catalog/search") return send(200, { items: [org(0), org(1)], total: 2 });
    if (u.pathname === "/api/catalog/pool") return send(200, { poolSize: 2 });
    if (u.pathname === "/api/catalog/causes") return send(200, { items: [org(0), org(1)] });
    return send(503, { error: "fixture indexer: not served" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Moves the node's clock to `timestamp` (seconds) and mines a block there. */
export async function warpTo(timestamp: number): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [timestamp]);
  await rpc("evm_mine");
}
