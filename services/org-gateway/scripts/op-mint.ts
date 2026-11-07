/**
 * Mints `<label>.org.varada.eth` names into `VaradaOrgNames` on Optimism from a catalogue build,
 * highest rank first, then writes the per-chain org id overrides.
 *
 *   tsx scripts/op-mint.ts [--build .catalog/build] [--state .catalog/op-mint-state.json]
 *                          [--batch 200] [--limit N] [--execute]
 *
 * Dry run by default: prints the plan, batch count and estimated gas and cost at the current
 * Optimism gas price. `--execute` needs:
 *   OP_PRIVATE_KEY      a registrar of the registry (or its owner)
 *   ORG_NAMES_ADDRESS   VaradaOrgNames on Optimism
 *   ORG_CUSTODY         who receives the tokens until charities claim them (default: the signer)
 *   OP_RPC_URL          default https://mainnet.optimism.io (publicnode refuses receipt lookups)
 * Before each batch it checks which names already exist on chain, so a rerun never double-mints
 * (`register` would revert on a taken label), and it saves the state file after every batch.
 * `--limit N` mints only the top N by rank (a demo subset); a later run without it continues.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readCatalog } from "@varada/cause-catalog";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { chunk, DEFAULT_MINT_BATCH, GAS_PER_NAME, orgNamesAbi, planMint } from "../src/opmint.js";

const { values: v } = parseArgs({
  options: {
    build: { type: "string", default: ".catalog/build" },
    state: { type: "string", default: ".catalog/op-mint-state.json" },
    batch: { type: "string", default: String(DEFAULT_MINT_BATCH) },
    limit: { type: "string" },
    execute: { type: "boolean", default: false },
  },
});

interface MintState {
  chainId: 10;
  registry: string | null;
  minted: Record<string, string>; // label -> tx hash
  overridesTx: string[];
}

const statePath = resolve(v.state!);
const batchSize = Math.max(1, Math.min(400, Number(v.batch)));
const limit = v.limit ? Number(v.limit) : Infinity;
const log = (x: unknown) => console.log(JSON.stringify(x, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2));

async function readState(): Promise<MintState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as MintState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { chainId: 10, registry: null, minted: {}, overridesTx: [] };
    throw e;
  }
}

async function saveState(s: MintState): Promise<void> {
  await writeFile(statePath + ".tmp", JSON.stringify(s, null, 2));
  await rename(statePath + ".tmp", statePath);
}

const catalog = await readCatalog(resolve(v.build!));
const plan = planMint(catalog.orgs);
const state = await readState();
const todo = plan.registrations.filter((r) => !state.minted[r.label]).slice(0, limit);
const batches = chunk(todo, batchSize);

const transport = http(process.env.OP_RPC_URL ?? "https://mainnet.optimism.io", { retryCount: 5, timeout: 60_000 });
const pub = createPublicClient({ chain: optimism, transport });
const gasPrice = await pub.getGasPrice();
const estGas = BigInt(todo.length) * GAS_PER_NAME + BigInt(plan.overrides.length) * 30_000n;

log({
  build: { namesRoot: catalog.meta.namesRoot ?? null, orgs: catalog.orgs.length },
  plan: { names: plan.registrations.length, overrides: plan.overrides.length, skipped: plan.skipped.length },
  alreadyMinted: Object.keys(state.minted).length,
  thisRun: { names: todo.length, batches: batches.length, batchSize },
  estimate: { gas: estGas, gasPriceGwei: Number(gasPrice) / 1e9, l2ExecutionEth: formatEther(estGas * gasPrice), note: "plus a small L1 data fee" },
  top: todo.slice(0, 5).map((r) => ({ label: r.label, rank: r.rank })),
});

if (!v.execute) {
  console.error("dry run: pass --execute to send");
  process.exit(0);
}

const key = process.env.OP_PRIVATE_KEY as Hex | undefined;
const registry = process.env.ORG_NAMES_ADDRESS;
if (!key) throw new Error("OP_PRIVATE_KEY is required with --execute");
if (!registry || !isAddress(registry)) throw new Error("ORG_NAMES_ADDRESS must be the VaradaOrgNames address");
if (state.registry && state.registry.toLowerCase() !== registry.toLowerCase()) {
  throw new Error(`state file ${statePath} belongs to registry ${state.registry}`);
}
state.registry = registry;
const account = privateKeyToAccount(key);
const custody = (process.env.ORG_CUSTODY ?? account.address) as Address;
if (!isAddress(custody)) throw new Error("ORG_CUSTODY is not an address");
const wallet = createWalletClient({ chain: optimism, transport, account });
if ((await pub.getChainId()) !== 10) throw new Error("OP_RPC_URL is not Optimism");

for (const [i, batch] of batches.entries()) {
  // Skip names that exist on chain already (a previous run that crashed before saving state).
  const existing = await pub.multicall({
    contracts: batch.map((r) => ({ address: registry as Address, abi: orgNamesAbi, functionName: "defaultOrgIdOf", args: [r.labelhash] }) as const),
    allowFailure: false,
  });
  const fresh = batch.filter((_r, j) => existing[j] === zeroHash);
  for (const [j, r] of batch.entries()) if (existing[j] !== zeroHash) state.minted[r.label] = "on-chain";
  if (fresh.length) {
    const hash = await wallet.writeContract({
      address: registry as Address,
      abi: orgNamesAbi,
      functionName: "register",
      args: [fresh.map((r) => ({ label: r.label, orgId: r.orgId })), custody],
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`batch ${i} reverted: ${hash}`);
    for (const r of fresh) state.minted[r.label] = hash;
    log({ batch: i + 1, of: batches.length, minted: fresh.length, gasUsed: rcpt.gasUsed, tx: hash });
  }
  await saveState(state);
}

// Overrides only for minted names; setChainOrgIds is idempotent, so resending is harmless.
const mintedSet = new Set(Object.keys(state.minted));
const byHash = new Map(plan.registrations.map((r) => [r.labelhash, r.label]));
const pending = plan.overrides.filter((o) => mintedSet.has(byHash.get(o.labelhash)!));
for (const part of chunk(pending, 300)) {
  const hash = await wallet.writeContract({
    address: registry as Address,
    abi: orgNamesAbi,
    functionName: "setChainOrgIds",
    args: [part.map((o) => ({ labelhash: o.labelhash, chainId: BigInt(o.chainId), orgId: o.orgId }))],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`overrides reverted: ${hash}`);
  state.overridesTx.push(hash);
  await saveState(state);
  log({ overrides: part.length, tx: hash });
}
log({ done: true, minted: mintedSet.size });
