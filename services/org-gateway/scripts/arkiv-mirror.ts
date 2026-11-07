/**
 * Mirrors a catalogue build onto Arkiv (Rabdi testnet) as `varada.org` entities.
 *
 *   tsx scripts/arkiv-mirror.ts [sync|extend] [--build .catalog/build] [--state .catalog/arkiv-org-state.json]
 *                               [--batch 25] [--limit N] [--older-than-days 150] [--execute]
 *                               [--mint-state .catalog/op-mint-state.json] [--l2-registry 0x…]
 *                               [--check-claims --custody 0x…]
 *
 * Name status: without --mint-state every name is `unminted`; with it, labels in its `minted` map
 * are `minted`; --check-claims also multicalls `ownerOf(uint256(labelhash))` on Optimism (OP_RPC_URL,
 * default https://mainnet.optimism.io) and marks names owned by anyone but --custody `claimed`.
 * A status change patches the existing entity (keys come from the state file); it never re-creates.
 *
 * Dry run by default: prints what it would write. `--execute` needs ARKIV_PRIVATE_KEY (the signer is
 * the `$creator` readers trust) and optionally ARKIV_ACCESS_KEY / ARKIV_RPC_URL. The state file is
 * saved after every batch, so an interrupted run resumes where it stopped. Entities live at most
 * ~182 days (MAX_LIFETIME blocks); run `extend` before then (it re-extends entries older than
 * --older-than-days).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { readCatalog } from "@varada/cause-catalog";
import { http, isHex, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  chunk,
  DEFAULT_BATCH,
  emptyState,
  encodeOrgEntity,
  ORG_ENTITY_COLUMNS,
  OrgEntity,
  planMirror,
  staleEntries,
  unsetColumns,
  claimedLabels,
  nameStatusOf,
  ORG_L2_REGISTRY,
  tokenIdOf,
  type MirrorState,
  type NameInfo,
} from "../src/arkiv.js";
import { createPublicClient as createViemClient, isAddress, parseAbi } from "viem";
import { optimism } from "viem/chains";

const RABDI_CHAIN_ID = 7794095;

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: "string", default: ".catalog/build" },
    state: { type: "string", default: ".catalog/arkiv-org-state.json" },
    batch: { type: "string", default: String(DEFAULT_BATCH) },
    limit: { type: "string" },
    "older-than-days": { type: "string", default: "150" },
    execute: { type: "boolean", default: false },
    "mint-state": { type: "string" },
    "l2-registry": { type: "string", default: ORG_L2_REGISTRY },
    "check-claims": { type: "boolean", default: false },
    custody: { type: "string" },
  },
});
const cmd = positionals[0] ?? "sync";
const statePath = resolve(v.state!);
const batch = Math.max(1, Number(v.batch));
const limit = v.limit ? Number(v.limit) : Infinity;
const out = (x: unknown) => console.log(JSON.stringify(x, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2));

async function readState(): Promise<MirrorState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as MirrorState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState(RABDI_CHAIN_ID);
    throw e;
  }
}
async function saveState(s: MirrorState) {
  await writeFile(`${statePath}.tmp`, JSON.stringify(s));
  await rename(`${statePath}.tmp`, statePath);
}

function clients() {
  const pk = process.env.ARKIV_PRIVATE_KEY;
  if (!pk || !isHex(pk) || pk.length !== 66) throw new Error("--execute needs ARKIV_PRIVATE_KEY (0x + 64 hex)");
  const base = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
  const chain = process.env.ARKIV_RPC_URL ? { ...base, rpcUrls: { default: { http: [process.env.ARKIV_RPC_URL] } } } : base;
  const account = privateKeyToAccount(pk as Hex);
  return {
    publicClient: createPublicClient({ chain, transport: http() }),
    walletClient: createWalletClient({ chain, transport: http(), account }),
  };
}

/** Name status inputs from --mint-state and (optionally) an ownerOf sweep on Optimism. */
async function nameInfo(labels: string[]): Promise<NameInfo> {
  const registry = v["l2-registry"]!;
  if (!isAddress(registry)) throw new Error("--l2-registry is not an address");
  let minted = new Set<string>();
  if (v["mint-state"]) {
    const ms = JSON.parse(await readFile(resolve(v["mint-state"]), "utf8")) as { registry?: string | null; minted?: Record<string, string> };
    if (ms.registry && ms.registry.toLowerCase() !== registry.toLowerCase()) {
      throw new Error(`--mint-state belongs to registry ${ms.registry}, not ${registry}`);
    }
    minted = new Set(Object.keys(ms.minted ?? {}));
  }
  let claimed = new Set<string>();
  if (v["check-claims"]) {
    if (!v.custody || !isAddress(v.custody)) throw new Error("--check-claims needs --custody <address>");
    const op = createViemClient({ chain: optimism, transport: http(process.env.OP_RPC_URL ?? "https://mainnet.optimism.io", { timeout: 60_000 }) });
    const abi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
    const todo = labels.filter((l) => minted.has(l));
    for (const group of chunk(todo, 500)) {
      const res = await op.multicall({
        contracts: group.map((l) => ({ address: registry as Hex, abi, functionName: "ownerOf", args: [BigInt(tokenIdOf(l))] }) as const),
        allowFailure: true,
        batchSize: 0,
      });
      for (const l of claimedLabels(group, res.map((r) => (r.status === "success" ? (r.result as string) : null)), v.custody)) claimed.add(l);
    }
  }
  return { registry: registry as Hex, minted, claimed };
}

async function sync() {
  const catalog = await readCatalog(resolve(v.build!));
  const namesRoot = catalog.meta.namesRoot;
  if (!namesRoot) throw new Error("build has no namesRoot; rebuild the catalogue");
  const state = await readState();
  if (state.chainId !== RABDI_CHAIN_ID) throw new Error(`state file is for chain ${state.chainId}, not Rabdi; use a new --state`);
  const names = await nameInfo(catalog.orgs.flatMap((o) => (o.label ? [o.label] : [])));
  const plan = planMirror(catalog.orgs, catalog.meta.taxonomyVersion, state, names);
  // Highest rank first, so a partial run (limited funds) covers the most relevant orgs.
  plan.creates.sort((a, b) => b.values.rank - a.values.rank || (a.values.label < b.values.label ? -1 : 1));
  const byStatus: Record<string, number> = { unminted: 0, minted: 0, claimed: 0 };
  for (const o of catalog.orgs) if (o.label) byStatus[nameStatusOf(o.label, names)]!++;
  const payloads = plan.creates.map(() => 0);
  const summary = {
    mode: v.execute ? "execute" : "dry-run",
    namesRoot,
    orgs: catalog.orgs.length,
    creates: plan.creates.length,
    patches: plan.patches.length,
    deletes: plan.deletes.length,
    unchanged: plan.unchanged,
    batchSize: batch,
    transactions:
      Math.ceil(Math.min(plan.creates.length, limit) / batch) +
      Math.ceil(plan.patches.length / batch) +
      Math.ceil(plan.deletes.length / batch),
    attributesPerEntity: ORG_ENTITY_COLUMNS + 1,
    l2Registry: names.registry,
    nameStatus: byStatus,
    claimsChecked: Boolean(v["check-claims"]),
    maxPayloadBytes: payloads.reduce((m, x) => (x > m ? x : m), 0),
    avgPayloadBytes: payloads.length ? Math.round(payloads.reduce((a, b) => a + b, 0) / payloads.length) : 0,
  };
  out(summary);
  if (!v.execute) return;

  const { walletClient } = clients();
  state.creator = walletClient.account.address;
  const now = () => new Date().toISOString();
  let written = 0;
  type Create = (typeof plan.creates)[number];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const create = (group: Create[]) =>
    walletClient.executeBatch({
      creates: group.map((c) => ({
        schema: OrgEntity,
        values: encodeOrgEntity(c.values, namesRoot),
        expiration: ExpirationTime.max(),
        flags: { permissionlessExtension: true },
      })),
    });
  // The public Rabdi endpoint fails batches intermittently ("Execution error without revert data")
  // that succeed on retry or one entity at a time, so: retry once, then write the group singly.
  const write = async (group: Create[]): Promise<{ keys: Hex[]; tx: string }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await create(group);
        if (r.createdEntities.length !== group.length) throw new Error(`batch created ${r.createdEntities.length} of ${group.length} (tx ${r.txHash})`);
        return { keys: r.createdEntities as Hex[], tx: r.txHash };
      } catch (e) {
        if (/insufficient funds/i.test(String(e))) throw e;
        console.error(`batch of ${group.length} failed (attempt ${attempt + 1}): ${String(e).split("\n")[0]}`);
        await sleep(3_000);
      }
    }
    if (group.length === 1) throw new Error(`entity ${group[0]!.values.label} failed twice`);
    const keys: Hex[] = [];
    let tx = "";
    for (const c of group) {
      const r = await write([c]);
      keys.push(r.keys[0]!);
      tx = r.tx;
    }
    return { keys, tx };
  };
  for (const group of chunk(plan.creates.slice(0, Number.isFinite(limit) ? limit : undefined), batch)) {
    const r = await write(group);
    group.forEach((c, i) => (state.entries[c.orgId] = { key: r.keys[i]!, hash: c.hash, writtenAt: now() }));
    await saveState(state);
    written += group.length;
    console.error(`created ${written}/${plan.creates.length} (tx ${r.tx})`);
  }
  for (const group of chunk(plan.patches, batch)) {
    const r = await walletClient.executeBatch({
      patches: group.map((p) => ({
        schema: OrgEntity,
        entityKey: p.key,
        set: encodeOrgEntity(p.values, namesRoot),
        unset: unsetColumns(p.values),
      })),
    });
    for (const p of group) state.entries[p.orgId] = { ...state.entries[p.orgId]!, hash: p.hash };
    await saveState(state);
    console.error(`patched ${group.length} (tx ${r.txHash})`);
  }
  for (const group of chunk(plan.deletes, batch)) {
    const r = await walletClient.executeBatch({ deletes: group.map((d) => ({ entityKey: d.key })) });
    for (const d of group) delete state.entries[d.orgId];
    await saveState(state);
    console.error(`deleted ${group.length} (tx ${r.txHash})`);
  }
}

async function extend() {
  const state = await readState();
  const days = Number(v["older-than-days"]);
  const stale = staleEntries(state, new Date(Date.now() - days * 86_400_000));
  out({ mode: v.execute ? "execute" : "dry-run", entries: Object.keys(state.entries).length, toExtend: stale.length, transactions: Math.ceil(stale.length / batch) });
  if (!v.execute) return;
  const { walletClient } = clients();
  let done = 0;
  for (const group of chunk(stale.slice(0, Number.isFinite(limit) ? limit : undefined), batch)) {
    const r = await walletClient.executeBatch({
      extensions: group.map((e) => ({ entityKey: e.key, expiration: ExpirationTime.max() })),
    });
    const at = new Date().toISOString();
    for (const e of group) state.entries[e.orgId] = { ...state.entries[e.orgId]!, writtenAt: at };
    await saveState(state);
    done += group.length;
    console.error(`extended ${done}/${stale.length} (tx ${r.txHash})`);
  }
}

const run = cmd === "sync" ? sync : cmd === "extend" ? extend : null;
if (!run) {
  console.error(`unknown command ${cmd}; use sync or extend`);
  process.exitCode = 1;
} else {
  run().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
