// pnpm dev:up: a mainnet fork (anvil), the whole Varada system deployed on it, the Ponder indexer and the
// web app wired to both, and a throwaway wallet the app can connect to. Everything runs detached;
// pnpm dev:down stops it. See docs/OVERVIEW.md ("One command").
//
// Needs FORK_RPC_URL (environment, or a gitignored .env.local at the repository root): a mainnet
// archive-capable RPC. It is passed to anvil only and scrubbed from every log and message.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  DEV_DIR, KEY_FILE, ROOT, findNode22, forkRpcUrl, httpOk, isOurs, pidAlive, readState, redact, resolvePort, rpcCall, secretsOf,
  spawnLogged, tailLog, teardown, waitFor, which, writeState,
} from "./lib.mjs";

const FORK_URL = forkRpcUrl();
const SECRETS = secretsOf(FORK_URL);
const say = (m) => console.log(redact(String(m), SECRETS));
const fail = (m) => {
  console.error(redact(String(m), SECRETS));
  process.exitCode = 1;
};

const args = new Set(process.argv.slice(2));
const withIndexer = !args.has("--no-indexer");
const withWeb = !args.has("--no-web");

let ownsState = false;
const USDC ="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const HOUR = 3600;

/** Runs a command to completion, appending scrubbed output to .dev/<log>; rejects with the log tail on failure. */
function run(label, cmd, cmdArgs, { cwd = ROOT, env = process.env, logName } = {}) {
  return new Promise((resolve, reject) => {
    const logFile = join(DEV_DIR, logName ?? `${label}.log`);
    const out = createWriteStream(logFile, { flags: "w", mode: 0o600 });
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let captured = "";
    const sink = (chunk) => {
      const text = redact(chunk.toString(), SECRETS);
      captured += text;
      out.write(text);
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (e) => reject(new Error(`${label}: ${redact(e.message, SECRETS)}`)));
    child.on("close", (code) => {
      out.end();
      if (code === 0) resolve(captured);
      else reject(new Error(`${label} failed (exit ${code}). Last output:\n${captured.split("\n").slice(-25).join("\n")}\nFull log: ${logFile}`));
    });
  });
}

function preflight() {
  if (!FORK_URL) {
    throw new Error(
      "FORK_RPC_URL is not set. Export a mainnet RPC URL (archive-capable) before running, or put\n  FORK_RPC_URL=<url>\nin a gitignored .env.local at the repository root. It is only given to anvil and never printed.",
    );
  }
  if (!/^https?:\/\//.test(FORK_URL)) throw new Error("FORK_RPC_URL must be an http(s) URL");
  for (const bin of ["anvil", "forge", "cast", "pnpm"]) {
    if (!which(bin)) throw new Error(`${bin} not found on PATH${bin === "pnpm" ? " (corepack enable)" : " (install Foundry: https://getfoundry.sh)"}`);
  }
}

async function ensureDeps(node22) {
  // pnpm must run under the Node that will run Ponder: an install under Node 20 does not fetch Rolldown's native binding.
  const env = { ...process.env, PATH: `${dirname(node22)}${delimiter}${process.env.PATH}` };
  const ponderOk = () => {
    try {
      execFileSync(node22, ["-e", "require('rolldown')"], { cwd: join(ROOT, "services", "indexer"), stdio: "ignore", env });
      return true;
    } catch {
      return false;
    }
  };
  if (!existsSync(join(ROOT, "node_modules", ".pnpm")) || (withIndexer && !ponderOk())) {
    say("installing workspace dependencies (pnpm install, Node 22)...");
    await run("pnpm-install", "pnpm", ["install", "--prefer-offline"], { env });
  }
  // Everything foundry.toml remaps to, including the nested ones (permit2, solmate).
  const libs = ["forge-std/src", "openzeppelin-contracts/contracts", "v4-core/src", "v4-core/lib/solmate/src", "v4-periphery/src", "v4-periphery/lib/permit2/src"];
  if (libs.some((l) => !existsSync(join(ROOT, "contracts", "lib", l)))) {
    say("fetching contract submodules...");
    // Only what the remappings need, not --recursive: the nested copies of OpenZeppelin and forge-std
    // inside v4-core and v4-periphery are big and unused.
    const lib = join(ROOT, "contracts", "lib");
    await run("submodules", "git", ["submodule", "update", "--init", "--", "contracts/lib/forge-std", "contracts/lib/openzeppelin-contracts", "contracts/lib/v4-core", "contracts/lib/v4-periphery"], { cwd: ROOT, logName: "submodules.log" });
    await run("submodules-nested", "git", ["submodule", "update", "--init", "--", "lib/solmate"], { cwd: join(lib, "v4-core"), logName: "submodules.log" });
    await run("submodules-nested", "git", ["submodule", "update", "--init", "--", "lib/permit2"], { cwd: join(lib, "v4-periphery"), logName: "submodules.log" });
  }
  if (!existsSync(join(ROOT, "contracts", "node_modules", "@fhevm"))) {
    say("installing Solidity dependencies in contracts/...");
    await run("contracts-deps", "pnpm", ["install", "--frozen-lockfile", "--ignore-workspace"], { cwd: join(ROOT, "contracts"), env });
  }
  return env;
}

function newTestKey() {
  const raw = execFileSync("cast", ["wallet", "new", "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(raw);
  const w = Array.isArray(parsed) ? parsed[0] : parsed;
  const key = w.private_key ?? w.privateKey;
  const address = w.address;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("cast wallet new returned an unexpected shape");
  return { key, address };
}

async function main() {
  preflight();
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });

  const prior = readState();
  if (prior) {
    const live = Object.values(prior.procs ?? {}).some((p) => isOurs(p));
    if (live) {
      throw new Error(`A dev stack is already running (web ${prior.urls?.web ?? "?"}). Run pnpm dev:down first.`);
    }
    say("clearing stale state from an earlier run");
    await teardown(prior, { log: () => {} });
  }

  const node22 = findNode22();
  if (withIndexer && !node22) {
    throw new Error("The indexer needs Node 22.12 or newer. Install it (nvm install 22) or set NODE22_BIN, or pass --no-indexer.");
  }
  const installEnv = await ensureDeps(node22 ?? process.execPath);

  const anvilPort = await resolvePort("DEV_ANVIL_PORT", []);
  const indexerPort = await resolvePort("DEV_INDEXER_PORT", [anvilPort]);
  const webPort = await resolvePort("DEV_WEB_PORT", [anvilPort, indexerPort]);
  const rpcUrl = `http://127.0.0.1:${anvilPort}`;
  const indexerUrl = `http://127.0.0.1:${indexerPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  const { key, address } = newTestKey();
  writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);

  const state = { startedAt: new Date().toISOString(), ports: { anvil: anvilPort, indexer: indexerPort, web: webPort }, procs: {}, urls: { rpc: rpcUrl }, wallet: address };
  writeState(state);
  ownsState = true;
  let interrupted = false;
  const onSignal = async () => {
    if (interrupted) return;
    interrupted = true;
    console.error("\ninterrupted, cleaning up...");
    await teardown(readState() ?? state, { log: () => {} });
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const track = (name, entry) => {
    state.procs[name] = { pid: entry.pid, started: entry.started, log: entry.logFile };
    writeState(state);
    return entry;
  };

  // 1. anvil -------------------------------------------------------------------------------
  say(`starting anvil fork on ${rpcUrl} ...`);
  const forkArgs = [
    "--fork-url", FORK_URL, "--chain-id", "1", "--host", "127.0.0.1", "--port", String(anvilPort),
    "--auto-impersonate", "--retries", "8", "--timeout", "60000",
  ];
  if (process.env.FORK_BLOCK_NUMBER) forkArgs.push("--fork-block-number", process.env.FORK_BLOCK_NUMBER);
  const anvil = track("anvil", spawnLogged("anvil", "anvil", forkArgs, { secrets: SECRETS }));
  await waitFor("anvil", async () => (await rpcCall(rpcUrl, "eth_chainId")) === "0x1", { timeoutMs: 180_000, alive: () => pidAlive(anvil.pid) });
  say("anvil is up (chain id 1)");

  // 2. test wallet ------------------------------------------------------------------------
  await rpcCall(rpcUrl, "anvil_setBalance", [address, "0x" + (1000n * 10n ** 18n).toString(16)]);
  // FiatToken keeps balances in the mapping at storage slot 9.
  const slot = execFileSync("cast", ["index", "address", address, "9"], { encoding: "utf8" }).trim();
  await rpcCall(rpcUrl, "anvil_setStorageAt", [USDC, slot, "0x" + (100_000n * 10n ** 6n).toString(16).padStart(64, "0")]);

  // 3. deploy the fixture -----------------------------------------------------------------
  say("deploying Varada with the E2E fixture (first run compiles the contracts, a few minutes)...");
  // contracts/deployments is gitignored, so a clean clone has no such directory for the script to write into.
  mkdirSync(join(ROOT, "contracts", "deployments"), { recursive: true });
  rmSync(join(ROOT, "contracts", "deployments", "e2e.json"), { force: true });
  await run(
    "deploy",
    "forge",
    ["script", "script/E2eFixture.s.sol:E2eFixture", "--sig", "phase1()", "--rpc-url", rpcUrl, "--sender", address, "--unlocked", "--broadcast", "--skip", "test/**"],
    { cwd: join(ROOT, "contracts"), env: installEnv, logName: "deploy.log" },
  );
  const fixtureSrc = join(ROOT, "contracts", "deployments", "e2e.json");
  if (!existsSync(fixtureSrc)) throw new Error("forge finished but contracts/deployments/e2e.json was not written");
  const fixtureFile = join(DEV_DIR, "fixture.json");
  copyFileSync(fixtureSrc, fixtureFile);
  const fx = JSON.parse(readFileSync(fixtureFile, "utf8"));
  const needed = ["factory", "feeVault", "feeConsolidator", "quoteRegistry", "causeRegistry", "epochGovernor", "donationDistributor", "profileRegistry", "causeCatalog", "curatorRegistry", "votingScheme", "takeoverGovernor", "mockScheme", "token", "deployBlock"];
  for (const k of needed) if (fx[k] === undefined) throw new Error(`fixture is missing ${k}`);

  // The catalogue was published after epoch 0 began, so epoch 0 has no pool: sit two hours into epoch 1.
  const epoch1 = BigInt(execFileSync("cast", ["call", fx.epochGovernor, "epochStart(uint256)(uint256)", "1", "--rpc-url", rpcUrl], { encoding: "utf8" }).trim().split(/\s/)[0]);
  const target = epoch1 + BigInt(2 * HOUR);
  const head = await rpcCall(rpcUrl, "eth_getBlockByNumber", ["latest", false]);
  if (BigInt(head.timestamp) < target) {
    await rpcCall(rpcUrl, "evm_setNextBlockTimestamp", ["0x" + target.toString(16)]);
    await rpcCall(rpcUrl, "evm_mine");
  }
  say(`deployed: factory ${fx.factory}, fixture token ${fx.token}`);

  // 4. indexer ----------------------------------------------------------------------------
  if (withIndexer) {
    say("starting the indexer (Ponder, Node 22) ...");
    // A previous run left a sync cache keyed by chain id 1: it would replay a different fork's logs.
    rmSync(join(ROOT, "services", "indexer", ".ponder"), { recursive: true, force: true });
    const indexerEnv = {
      ...process.env,
      PATH: `${dirname(node22)}${delimiter}${process.env.PATH}`,
      PONDER_RPC_URL_1: rpcUrl,
      START_BLOCK: String(fx.deployBlock),
      FACTORY_ADDRESS: fx.factory,
      FEE_VAULT_ADDRESS: fx.feeVault,
      FEE_CONSOLIDATOR_ADDRESS: fx.feeConsolidator,
      QUOTE_REGISTRY_ADDRESS: fx.quoteRegistry,
      CAUSE_REGISTRY_ADDRESS: fx.causeRegistry,
      EPOCH_GOVERNOR_ADDRESS: fx.epochGovernor,
      DONATION_DISTRIBUTOR_ADDRESS: fx.donationDistributor,
      TOKEN_REGISTRY_ADDRESS: fx.profileRegistry,
      CAUSE_CATALOG_ADDRESS: fx.causeCatalog,
      CURATOR_REGISTRY_ADDRESS: fx.curatorRegistry,
      VOTING_SCHEME_ADDRESS: fx.votingScheme,
      TAKEOVER_GOVERNOR_ADDRESS: fx.takeoverGovernor,
      DATABASE_SCHEMA: "varada_dev",
      PORT: String(indexerPort),
      CORS_ALLOWED_ORIGINS: `${webUrl},http://localhost:${webPort}`,
      NODE_ENV: "development",
    };
    delete indexerEnv.DATABASE_URL;
    const indexer = track(
      "indexer",
      spawnLogged("indexer", "pnpm", ["--filter", "@varada/indexer", "exec", "ponder", "dev", "--disable-ui", "--port", String(indexerPort)], { env: indexerEnv, secrets: SECRETS }),
    );
    await waitFor("indexer /ready", () => httpOk(`${indexerUrl}/ready`), { timeoutMs: 240_000, intervalMs: 1000, alive: () => pidAlive(indexer.pid) });
    say(`indexer is ready on ${indexerUrl}`);
  }

  // 5. web --------------------------------------------------------------------------------
  if (withWeb) {
    say("starting the web app (next dev) ...");
    const webEnv = {
      ...process.env,
      NEXT_PUBLIC_DEV_STACK: "true",
      NEXT_PUBLIC_DEV_WALLET_KEY: key,
      NEXT_PUBLIC_DEV_PLAIN_BALLOTS: "true",
      NEXT_PUBLIC_CHAIN_ID: "1",
      NEXT_PUBLIC_RPC_URL: rpcUrl,
      NEXT_PUBLIC_PRIVATE_RPC_URLS: rpcUrl,
      NEXT_PUBLIC_ANON_RPC_NETWORK: "passthrough",
      NEXT_PUBLIC_INDEXER_URLS: withIndexer ? indexerUrl : "http://127.0.0.1:9",
      NEXT_PUBLIC_FACTORY_ADDRESS: fx.factory,
      NEXT_PUBLIC_FACTORY_DEPLOY_BLOCK: String(fx.deployBlock),
      NEXT_PUBLIC_VAULT_ADDRESS: fx.feeVault,
      NEXT_PUBLIC_GOVERNOR_ADDRESS: fx.epochGovernor,
      NEXT_PUBLIC_DONATION_DISTRIBUTOR_ADDRESS: fx.donationDistributor,
      NEXT_PUBLIC_PROFILE_REGISTRY_ADDRESS: fx.profileRegistry,
      NEXT_PUBLIC_VOTING_SCHEME_ADDRESS: fx.mockScheme,
      NEXT_PUBLIC_TAKEOVER_GOVERNOR_ADDRESS: fx.takeoverGovernor,
      NEXT_PUBLIC_CURATOR_REGISTRY_ADDRESS: fx.curatorRegistry,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const web = track(
      "web",
      spawnLogged("web", "pnpm", ["--filter", "@varada/web", "exec", "next", "dev", "-H", "127.0.0.1", "-p", String(webPort)], { env: webEnv, secrets: SECRETS }),
    );
    await waitFor("web", () => httpOk(`${webUrl}/`, 120_000), { timeoutMs: 300_000, intervalMs: 1500, alive: () => pidAlive(web.pid) });
    // Compile the helper page now so the first click is not a cold start.
    await httpOk(`${webUrl}/dev-wallet/`, 120_000).catch(() => {});
    say(`web is ready on ${webUrl}`);
  }

  state.urls = { rpc: rpcUrl, indexer: withIndexer ? indexerUrl : null, web: withWeb ? webUrl : null, walletPage: withWeb ? `${webUrl}/dev-wallet/` : null };
  state.fixture = fixtureFile;
  writeState(state);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  say(`
Varada dev stack is up.
  web            ${state.urls.web ?? "(skipped)"}
  dev wallet     ${state.urls.walletPage ?? "(skipped)"}   ${address}
  indexer        ${state.urls.indexer ?? "(skipped)"}   (GET /api/tokens, /ready)
  anvil RPC      ${rpcUrl}   (chain id 1, forked mainnet)
  fixture token  ${fx.token}
  fixture json   ${fixtureFile}
  logs           ${DEV_DIR}/{anvil,indexer,web,deploy}.log
Connect "Varada Dev Wallet" in the app header. Stop everything with: pnpm dev:down`);
}

main().catch(async (e) => {
  fail(e.message ?? e);
  // Only what this invocation started: a refused second `dev:up` must leave the running stack alone.
  const state = ownsState ? readState() : null;
  if (state) {
    for (const [name, p] of Object.entries(state.procs ?? {})) {
      const t = tailLog(p.log, 12);
      if (t) console.error(redact(`--- ${name} log (tail) ---\n${t}`, SECRETS));
    }
    console.error("cleaning up...");
    await teardown(state, { log: () => {} });
  }
  process.exit(1);
});
