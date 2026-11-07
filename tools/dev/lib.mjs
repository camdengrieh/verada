// Shared helpers for `pnpm dev:up` / `pnpm dev:down` (no dependencies, runs on Node 20).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEV_DIR = join(ROOT, ".dev");
export const STATE_FILE = join(DEV_DIR, "state.json");
export const KEY_FILE = join(DEV_DIR, "test-key");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- secrets

/**
 * Every string that identifies a private RPC endpoint: the whole URL, its credentials, each long path
 * segment (API keys live there) and each query value. Used to scrub anything that reaches a log or a
 * terminal.
 */
export function secretsOf(rpcUrl) {
  const out = new Set();
  if (!rpcUrl) return [];
  out.add(rpcUrl);
  try {
    const u = new URL(rpcUrl);
    if (u.password) out.add(u.password);
    if (u.username) out.add(u.username);
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) out.add(seg);
    for (const v of u.searchParams.values()) if (v.length >= 8) out.add(v);
    if (u.search) out.add(u.search);
  } catch {
    /* not a URL: the whole string is still scrubbed */
  }
  // Longest first so a URL is replaced before the key inside it.
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(text, secrets) {
  let s = text;
  for (const secret of secrets) if (secret) s = s.split(secret).join("<redacted>");
  return s;
}

// ---------------------------------------------------------------- env files

/** Minimal KEY=VALUE reader for the root `.env.local` / `.env` (both gitignored). Process env wins. */
export function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

export function forkRpcUrl(env = process.env) {
  const fromFiles = { ...readEnvFile(join(ROOT, ".env")), ...readEnvFile(join(ROOT, ".env.local")) };
  const url = (env.FORK_RPC_URL ?? fromFiles.FORK_RPC_URL ?? "").trim();
  return url;
}

// ---------------------------------------------------------------- ports

export function portIsFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host }, () => srv.close(() => resolve(true)));
  });
}

/** A random free port above 20000 that is not in `taken`. */
export async function pickPort(taken = []) {
  for (let i = 0; i < 200; i++) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    if (taken.includes(port)) continue;
    if ((await portIsFree(port)) && (await portIsFree(port, "0.0.0.0"))) return port;
  }
  throw new Error("could not find a free port above 20000");
}

/** An explicit port from the environment (must be free), else a random free one. */
export async function resolvePort(envName, taken) {
  const raw = process.env[envName];
  if (!raw) return pickPort(taken);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${envName} must be a port between 1024 and 65535`);
  if (taken.includes(port) || !(await portIsFree(port))) throw new Error(`${envName}=${port} is already in use`);
  return port;
}

// ---------------------------------------------------------------- processes

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Start time of a pid as `ps` prints it; guards against killing an unrelated process that reused the pid. */
export function startTimeOf(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** True when `pid` is still the process we started. */
export function isOurs(entry) {
  return Boolean(entry) && pidAlive(entry.pid) && startTimeOf(entry.pid) === entry.started;
}

function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/** SIGTERM the process group, then SIGKILL whatever is left after `graceMs`. */
export async function stopEntry(entry, graceMs = 8000) {
  if (!isOurs(entry)) return false;
  signalGroup(entry.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pidAlive(entry.pid)) await sleep(150);
  if (pidAlive(entry.pid)) {
    signalGroup(entry.pid, "SIGKILL");
    await sleep(200);
  }
  return true;
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(state) {
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Stops every process recorded in the state (reverse start order), removes the state and the key. */
export async function teardown(state, { log = console.log } = {}) {
  if (!state) return;
  const order = ["web", "indexer", "anvil"];
  for (const name of order) {
    const entry = state.procs?.[name];
    if (!entry) continue;
    const stopped = await stopEntry(entry);
    log(stopped ? `stopped ${name} (pid ${entry.pid})` : `${name}: not running`);
  }
  rmSync(STATE_FILE, { force: true });
  rmSync(KEY_FILE, { force: true });
}

/**
 * Starts `cmd` detached in its own process group, with output scrubbed of `secrets` and appended to
 * `logFile`, through tools/dev/run-logged.mjs. Returns { pid, started, logFile }.
 */
export function spawnLogged(name, cmd, args, { cwd = ROOT, env = process.env, secrets = [] } = {}) {
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  const logFile = join(DEV_DIR, `${name}.log`);
  writeFileSync(logFile, "", { mode: 0o600 });
  const childEnv = { ...env, DEV_REDACT: JSON.stringify(secrets) };
  delete childEnv.FORK_RPC_URL;
  const wrapper = spawn(process.execPath, [join(ROOT, "tools", "dev", "run-logged.mjs"), logFile, "--", cmd, ...args], {
    cwd,
    env: childEnv,
    detached: true,
    stdio: "ignore",
  });
  wrapper.unref();
  return { pid: wrapper.pid, started: startTimeOf(wrapper.pid), logFile, name };
}

export function tailLog(file, lines = 25) {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- waiting

export async function waitFor(label, check, { timeoutMs = 120_000, intervalMs = 500, alive } = {}) {
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < timeoutMs) {
    if (alive && !alive()) throw new Error(`${label}: process exited before it was ready`);
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label}: not ready after ${Math.round(timeoutMs / 1000)}s${lastErr ? ` (${lastErr})` : ""}`);
}

export async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function httpOk(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  await res.arrayBuffer();
  return res.ok;
}

// ---------------------------------------------------------------- tools

export function which(bin) {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** A Node >= 22.12 for Ponder: the running one, $NODE22_BIN, or the newest 22+ under ~/.nvm. */
export function findNode22(env = process.env) {
  const ok = (v) => {
    const [maj, min] = v.replace(/^v/, "").split(".").map(Number);
    return maj > 22 || (maj === 22 && min >= 12);
  };
  if (ok(process.version)) return process.execPath;
  if (env.NODE22_BIN && existsSync(env.NODE22_BIN)) return env.NODE22_BIN;
  const nvm = join(env.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  if (existsSync(nvm)) {
    const versions = readdirSync(nvm)
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && ok(v))
      .sort((a, b) => {
        const pa = a.slice(1).split(".").map(Number);
        const pb = b.slice(1).split(".").map(Number);
        return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
      });
    // Prefer an even (LTS) major when one exists.
    const lts = versions.find((v) => Number(v.slice(1).split(".")[0]) % 2 === 0) ?? versions[0];
    if (lts) return join(nvm, lts, "bin", "node");
  }
  return null;
}
