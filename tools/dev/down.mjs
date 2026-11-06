// pnpm dev:down: stops what pnpm dev:up started (web, indexer, anvil), removes the state and the
// throwaway key, keeps the logs in .dev/. Pass --purge to delete .dev/ entirely.
import { rmSync } from "node:fs";
import { DEV_DIR, readState, teardown } from "./lib.mjs";

const state = readState();
if (!state) {
  console.log("no dev stack recorded in .dev/state.json; nothing to stop");
} else {
  await teardown(state);
  console.log("dev stack stopped");
}
if (process.argv.includes("--purge")) {
  rmSync(DEV_DIR, { recursive: true, force: true });
  console.log("removed .dev/");
}
