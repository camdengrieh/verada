import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { BUCKET_COUNT, CATEGORIES, REGIONS, bucketParts } from "@varada/sdk";
import type { Hex } from "viem";
import { buildCatalog, entryProof } from "./build.js";
import { setVersionCalldata } from "./calldata.js";
import { coverage, crawlClient, harvest, loadHarvest, readState } from "./harvest.js";
import { CATALOG_FILES, readCatalog, readLabels, readOverrides, writeCatalog } from "./io.js";
import { NamesIndex } from "./names.js";
import { exportCcip } from "./export.js";
import { multicallReader, readAddressCache, verifyAddresses } from "./addresses.js";
import { createPublicClient, http } from "viem";
import { base, mainnet, optimism } from "viem/chains";

const HELP = `varada-catalog <command> [options]

  harvest    crawl Endaoment org search into --harvest-dir (resumable)
  verify-addresses
             check every org's API address per chain against Endaoment's L1 factory (Multicall3)
             and read orgId() where they differ, into --addresses-dir (resumable)
  build      classify, bucket and build the Merkle tree into --out
  stats      print per-category, per-region and per-bucket counts of a built catalogue
  proof      print the entries and proofs of one org (--org <orgId>)
  name-proof print the names shard proof of one label (--label <label>)
  export-ccip
             write the static CCIP-Read fallback (--build <dir> --out <dir>): ccip/<shard>.json
             for every names shard, plus l2-fallback.json
  publish    upload --out to a Bee node (dry-run unless --execute); prints the swarm reference
  calldata   print CauseCatalog.setVersion calldata (--swarm-ref <hex>); never signs or sends

Common:   --harvest-dir <dir> (default .catalog/harvest)  --out <dir> (default .catalog/build)
          --addresses-dir <dir> (default .catalog/addresses; read by build)
verify-addresses: --batch 500 --interval-ms 250
          env: ETH_RPC_URL, OP_RPC_URL, BASE_RPC_URL (default publicnode)
harvest:  --partitions A,B,...  --max-per-partition <n>  --interval-ms 1000
          env: ENDAOMENT_API_URL (default production), ENDAOMENT_API_KEY (optional)
build:    --overrides <file> (default packages/cause-catalog/region-overrides.json)
          --previous-labels <file> (default <out>/labels.json when present; labels are append-only)
publish:  --execute --pin   env: BEE_URL (default http://localhost:1633), BEE_POSTAGE_BATCH_ID
`;

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    "harvest-dir": { type: "string", default: ".catalog/harvest" },
    out: { type: "string", default: ".catalog/build" },
    partitions: { type: "string" },
    "max-per-partition": { type: "string" },
    "interval-ms": { type: "string" },
    overrides: { type: "string", default: "packages/cause-catalog/region-overrides.json" },
    org: { type: "string" },
    label: { type: "string" },
    "previous-labels": { type: "string" },
    "addresses-dir": { type: "string", default: ".catalog/addresses" },
    batch: { type: "string", default: "500" },
    build: { type: "string" },
    "swarm-ref": { type: "string" },
    execute: { type: "boolean", default: false },
    pin: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

/** Whether `--out` was passed explicitly (export-ccip must not default into the build dir). */
const positionalsHasOut = () => process.argv.some((a) => a === "--out" || a.startsWith("--out="));

const out = (s: unknown) => process.stdout.write(typeof s === "string" ? s + "\n" : JSON.stringify(s, null, 2) + "\n");

async function main(): Promise<void> {
  const cmd = positionals[0];
  if (!cmd || v.help) return void out(HELP);
  const harvestDir = resolve(v["harvest-dir"]!);
  const outDir = resolve(v.out!);
  const addressesDir = resolve(v["addresses-dir"]!);

  switch (cmd) {
    case "harvest": {
      const client = crawlClient({ baseUrl: process.env.ENDAOMENT_API_URL, apiKey: process.env.ENDAOMENT_API_KEY });
      const state = await harvest({
        client,
        dir: harvestDir,
        partitions: v.partitions?.split(",").map((s) => s.trim().toUpperCase()),
        maxPerPartition: v["max-per-partition"] ? Number(v["max-per-partition"]) : undefined,
        minIntervalMs: Number(v["interval-ms"] ?? 1000),
        log: (m) => process.stderr.write(m + "\n"),
      });
      const orgs = await loadHarvest(harvestDir);
      out({ asOf: state.asOf, harvested: orgs.length, coverage: coverage(state, orgs) });
      return;
    }
    case "verify-addresses": {
      if (addressesDir === harvestDir || addressesDir.startsWith(harvestDir + "/")) {
        throw new Error("--addresses-dir must not be inside --harvest-dir");
      }
      const client = (chain: typeof mainnet | typeof optimism | typeof base, url: string) =>
        multicallReader(createPublicClient({ chain, transport: http(url, { timeout: 60_000 }) }) as never);
      const harvested = await loadHarvest(harvestDir);
      const res = await verifyAddresses({
        harvested,
        dir: addressesDir,
        readers: {
          1: client(mainnet, process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com"),
          10: client(optimism, process.env.OP_RPC_URL || "https://optimism-rpc.publicnode.com"),
          8453: client(base, process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com"),
        },
        batchSize: Number(v.batch),
        minIntervalMs: Number(v["interval-ms"] ?? 250),
        log: (m) => process.stderr.write(m + "\n"),
      });
      out(res);
      return;
    }
    case "build": {
      const state = await readState(harvestDir);
      const harvested = await loadHarvest(harvestDir);
      const labelsPath = v["previous-labels"] ? resolve(v["previous-labels"]) : join(outDir, CATALOG_FILES.labels);
      const previousLabels = await readLabels(labelsPath);
      if (v["previous-labels"] && !previousLabels) throw new Error(`--previous-labels ${labelsPath} does not exist`);
      const addresses = await readAddressCache(addressesDir);
      if (!addresses) {
        process.stderr.write(
          `warning: no address cache in ${addressesDir}; every chain uses the default orgId (unverified). Run verify-addresses first.\n`,
        );
      }
      const { catalog } = buildCatalog(harvested, {
        overrides: await readOverrides(resolve(v.overrides!)),
        sourceAsOf: state.asOf,
        previousLabels: previousLabels ?? undefined,
        addresses,
      });
      await writeCatalog(outDir, catalog);
      out({ root: catalog.meta.root, namesRoot: catalog.meta.namesRoot, ...catalog.meta.stats });
      return;
    }
    case "stats": {
      const { meta } = await readCatalog(outDir);
      out({ root: meta.root, ...meta.stats });
      const rows: string[] = [];
      for (let b = 0; b < BUCKET_COUNT; b++) {
        const size = meta.bucketSizes[b] ?? 0;
        if (!size) continue;
        const { categoryBit, regionBit } = bucketParts(b);
        const c = CATEGORIES.find((x) => x.bit === categoryBit)?.slug ?? `cat${categoryBit}`;
        const r = REGIONS.find((x) => x.bit === regionBit)?.slug ?? `reg${regionBit}`;
        rows.push(`${String(size).padStart(7)}  ${c} / ${r}`);
      }
      out(rows.sort().reverse().join("\n"));
      return;
    }
    case "proof": {
      if (!v.org) throw new Error("--org <orgId> is required");
      const c = await readCatalog(outDir);
      const org = c.orgs.find((o) => o.orgId.toLowerCase() === v.org!.toLowerCase() || o.id === v.org || o.ein === v.org);
      if (!org) throw new Error(`org ${v.org} is not in the catalogue`);
      out({
        orgId: org.orgId,
        name: org.name,
        entries: org.entries.map((e) => ({ ...e, proof: entryProof(c.tree, { ...e, orgId: org.orgId }) })),
      });
      return;
    }
    case "name-proof": {
      if (!v.label) throw new Error("--label <label> is required");
      const c = await readCatalog(outDir);
      if (!c.names) throw new Error(`${outDir} has no names; rebuild it`);
      const p = new NamesIndex(c.names.shards).nameProof(v.label);
      out({ label: v.label, namesRoot: c.meta.namesRoot, found: p.orgIds !== null, ...p });
      return;
    }
    case "export-ccip": {
      if (!v.build) throw new Error("--build <dir> is required (the catalogue to export)");
      if (!positionalsHasOut()) throw new Error("--out <dir> is required (where to write the static files)");
      const c = await readCatalog(resolve(v.build));
      out(await exportCcip(c, outDir));
      return;
    }
    case "publish": {
      await readCatalog(outDir); // validates the directory before uploading
      if (!v.execute) return void out(`dry run: would upload ${outDir}. Re-run with --execute.`);
      const batchId = process.env.BEE_POSTAGE_BATCH_ID;
      if (!batchId) throw new Error("BEE_POSTAGE_BATCH_ID is required with --execute");
      // A dev dependency: only this command uploads.
      const { Bee } = await import("@ethersphere/bee-js");
      const bee = new Bee(process.env.BEE_URL ?? "http://localhost:1633");
      const res = await bee.uploadFilesFromDirectory(batchId, outDir, { pin: v.pin });
      out({ reference: res.reference.toHex() });
      return;
    }
    case "calldata": {
      if (!v["swarm-ref"]) throw new Error("--swarm-ref <hex> is required");
      const { meta } = await readCatalog(outDir);
      const ref = (v["swarm-ref"].startsWith("0x") ? v["swarm-ref"] : `0x${v["swarm-ref"]}`) as Hex;
      out({ root: meta.root, bucketCount: meta.bucketSizes.length, calldata: setVersionCalldata(meta.root, meta.bucketSizes, ref) });
      return;
    }
    default:
      out(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
