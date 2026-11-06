#!/usr/bin/env node
// Turns the deployment manifest written by DeployV3Routes.s.sol into the two configs that follow a
// deployment. Prints; writes nothing. No secrets are involved (addresses and a block number only).
//
//   node script/manifest-to-config.mjs deployments/1-manifest.json indexer   > services/indexer/.env.deploy
//   node script/manifest-to-config.mjs deployments/1-manifest.json web       > apps/web/public/config.deploy.json
//
// `indexer` prints KEY=VALUE lines (add PONDER_RPC_URL_1, DATABASE_URL, DATABASE_SCHEMA yourself).
// `web` prints the address keys of apps/web/public/config.json; merge them into that file.
import { readFileSync } from "node:fs";

const [, , file, target] = process.argv;
if (!file || !["indexer", "web"].includes(target ?? "")) {
  console.error("usage: manifest-to-config.mjs <manifest.json> <indexer|web>");
  process.exit(1);
}
const m = JSON.parse(readFileSync(file, "utf8"));
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

if (target === "indexer") {
  for (const [k, v] of Object.entries(parse(m.indexerEnv))) console.log(`${k}=${v}`);
} else {
  console.log(JSON.stringify(parse(m.webConfig), null, 2));
}
