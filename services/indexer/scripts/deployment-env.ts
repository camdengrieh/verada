// Turns the deployment records written by DeployLive.s.sol into indexer configuration, so START_BLOCK
// and the contract addresses are never copied by hand.
//   pnpm --filter @varada/indexer deployment-env [--format env|cdk] [--dir contracts/deployments] [--chain 1]
// `env` prints lines for services/indexer/.env.local; `cdk` prints the `-c key=value` flags of
// infra/ (see infra/README.md). Reads only; prints no secrets (the RPC URL is not part of the record).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAddress } from "viem";

/** Deployment record key -> [indexer env variable, infra context key]. */
export const DEPLOYMENT_KEYS = {
  factory: ["FACTORY_ADDRESS", "factoryAddress"],
  feeVault: ["FEE_VAULT_ADDRESS", "feeVaultAddress"],
  feeConsolidator: ["FEE_CONSOLIDATOR_ADDRESS", "feeConsolidatorAddress"],
  quoteRegistry: ["QUOTE_REGISTRY_ADDRESS", "quoteRegistryAddress"],
  causeRegistry: ["CAUSE_REGISTRY_ADDRESS", "causeRegistryAddress"],
  causeCatalog: ["CAUSE_CATALOG_ADDRESS", "causeCatalogAddress"],
  epochGovernor: ["EPOCH_GOVERNOR_ADDRESS", "epochGovernorAddress"],
  donationDistributor: ["DONATION_DISTRIBUTOR_ADDRESS", "donationDistributorAddress"],
  profileRegistry: ["TOKEN_REGISTRY_ADDRESS", "tokenRegistryAddress"],
  takeoverGovernor: ["TAKEOVER_GOVERNOR_ADDRESS", "takeoverGovernorAddress"],
  votingScheme: ["VOTING_SCHEME_ADDRESS", "votingSchemeAddress"],
  curatorRegistry: ["CURATOR_REGISTRY_ADDRESS", "curatorRegistryAddress"],
} as const;

export type Json = Record<string, unknown>;
export interface Row {
  env: string;
  context: string;
  value: string;
}

/**
 * `main` is `deployments/<chain>.json`; `live` is `<chain>-live.json` (optional: weekly-only
 * deployments have none, and live mode is then not indexed).
 */
export function deploymentRows(main: Json, live?: Json): Row[] {
  const block = Number(main.deployBlock);
  if (!Number.isInteger(block) || block <= 0) {
    throw new Error("deployBlock must be a positive integer in the deployment record");
  }
  if (live && live.chainId !== undefined && main.chainId !== undefined && live.chainId !== main.chainId) {
    throw new Error("the live record is for a different chain than the main record");
  }
  const rows: Row[] = [{ env: "START_BLOCK", context: "startBlock", value: String(block) }];
  for (const [key, [env, context]] of Object.entries(DEPLOYMENT_KEYS)) {
    const v = main[key];
    if (typeof v !== "string" || !isAddress(v)) throw new Error(`deployment record: ${key} is not an address`);
    rows.push({ env, context, value: v });
  }
  if (live) {
    const v = live.rotationGovernor;
    if (typeof v !== "string" || !isAddress(v)) throw new Error("live record: rotationGovernor is not an address");
    rows.push({ env: "ROTATION_GOVERNOR_ADDRESS", context: "rotationGovernorAddress", value: v });
  }
  return rows;
}

export function formatRows(rows: Row[], format: "env" | "cdk"): string {
  return rows.map((r) => (format === "env" ? `${r.env}=${r.value}` : `-c ${r.context}=${r.value}`)).join("\n");
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

if (process.argv[1]?.endsWith("deployment-env.ts")) {
  const dir = resolve(arg("dir", "contracts/deployments"));
  const chain = arg("chain", "1");
  const format = arg("format", "env");
  if (format !== "env" && format !== "cdk") throw new Error("--format must be env or cdk");
  const main = readJson(`${dir}/${chain}.json`);
  let live: Json | undefined;
  try {
    live = readJson(`${dir}/${chain}-live.json`);
  } catch {
    process.stderr.write("no live record: ROTATION_GOVERNOR_ADDRESS left unset (live mode not indexed)\n");
  }
  console.log(formatRows(deploymentRows(main, live), format));
}
