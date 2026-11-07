import { serve } from "@hono/node-server";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { createApp } from "./app.js";
import { createRootReader, noRoot } from "./root.js";
import { loadBuilds, type BuildSet } from "./store.js";

/**
 * Env:
 *   ORG_BUILD_DIRS  comma-separated catalogue builds (directories or http(s) base URLs); the
 *                   newest two by `builtAt` are served. Default `.catalog/build`.
 *   ORG_RESOLVER    VaradaOrgResolver address: its `root()` picks the build, and CCIP requests
 *                   from other senders are refused. Optional.
 *   ETH_RPC_URL     Ethereum mainnet RPC (needed with ORG_RESOLVER).
 *   PORT            default 8790.
 * SIGHUP reloads the builds.
 */
const log = (level: string, msg: string, data: Record<string, unknown> = {}) =>
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, msg, ...data }));

const sources = (process.env.ORG_BUILD_DIRS ?? ".catalog/build").split(",").map((s) => s.trim()).filter(Boolean);
const resolverEnv = process.env.ORG_RESOLVER?.trim();
if (resolverEnv && !isAddress(resolverEnv)) throw new Error("ORG_RESOLVER is not an address");
const resolver = resolverEnv as Address | undefined;

let builds: BuildSet = await loadBuilds(sources);
log("info", "builds loaded", { builds: builds.builds.map((b) => ({ namesRoot: b.namesRoot, orgs: b.byLabel.size })) });

process.on("SIGHUP", () => {
  loadBuilds(sources)
    .then((b) => {
      builds = b;
      log("info", "builds reloaded", { newest: b.newest.namesRoot });
    })
    .catch((e) => log("error", "reload failed", { error: String(e) }));
});

const root = resolver
  ? createRootReader({
      client: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL) }),
      resolver,
      onError: (e) => log("warn", "root() read failed", { error: e instanceof Error ? e.message : String(e) }),
    })
  : noRoot;

const app = createApp({ builds: () => builds, root, resolver });
const port = Number(process.env.PORT ?? 8790);
serve({ fetch: app.fetch, port });
log("info", "org gateway listening", { port, resolver: resolver ?? null });
