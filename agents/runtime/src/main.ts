import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { rateLimiter } from "./chat.js";
import { readConfig } from "./config.js";
import { contextCache, loadCauseContext } from "./context.js";
import { apiKeys, loadRuntimeSecrets } from "./keys.js";
import { cliSchedule, commandArgv, curatorPrompt, exec, fileState, recordAgents, runEnv, scheduler, type RunRecord } from "./scheduler.js";
import { claudeAsker, createServer } from "./server.js";

const cfg = readConfig();
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const loaded = await loadRuntimeSecrets({ env: process.env, vaultId: cfg.RUNTIME_VAULT_ID, baseUrl: cfg.ONECLAW_BASE_URL });
log("runtime secrets", { loaded, anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY) });
if (cfg.schedulerBlocked) log("scheduler blocked", { reason: cfg.schedulerBlocked });

let lastRuns: RunRecord[] = [];
let schedulerError: string | null = null;

if (cfg.schedulerEnabled) {
  const keyOf = apiKeys({ vaultId: cfg.AGENTS_VAULT_ID, baseUrl: cfg.ONECLAW_BASE_URL });
  const s = scheduler({
    repoDir: cfg.REPO_DIR,
    schedule: () => cliSchedule(cfg.REPO_DIR, new Date()),
    agents: () => recordAgents(cfg.REPO_DIR),
    apiKey: keyOf,
    run: (a, _cause, key) => {
      const [cmd, args] = commandArgv(cfg.CURATOR_COMMAND, curatorPrompt(a.agent));
      return exec(cmd, args, { cwd: cfg.REPO_DIR, env: runEnv(process.env, a, key), timeoutMs: cfg.CURATOR_TIMEOUT_MINUTES * 60_000 });
    },
    state: fileState(cfg.STATE_FILE),
    now: () => new Date(),
    log,
  });
  const tick = () =>
    s
      .tick()
      .then((r) => {
        if (r.length) lastRuns = r;
        schedulerError = null;
      })
      .catch((e: unknown) => {
        schedulerError = e instanceof Error ? e.message : String(e);
        log("scheduler tick failed", { error: schedulerError });
      });
  void tick();
  setInterval(tick, 5 * 60_000);
  log("scheduler on", { repoDir: cfg.REPO_DIR });
}

const app = createServer({
  context: contextCache((label) => loadCauseContext(cfg.INDEXER_URL, label), cfg.CONTEXT_TTL_SECONDS * 1000),
  ask: claudeAsker(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "missing" }), { model: cfg.CHAT_MODEL, effort: cfg.CHAT_EFFORT }),
  allowedOrigins: cfg.allowedOrigins,
  limit: rateLimiter(cfg.CHAT_RATE_PER_MINUTE, cfg.CHAT_RATE_PER_DAY),
  chatReady: () => Boolean(process.env.ANTHROPIC_API_KEY),
  scheduler: cfg.schedulerEnabled
    ? () => ({ lastRuns: lastRuns.map((r) => ({ agent: r.agent, cause: r.cause, status: r.status, finishedAt: r.finishedAt })), error: schedulerError })
    : cfg.schedulerBlocked
      ? () => ({ blocked: cfg.schedulerBlocked })
      : undefined,
});

for (const port of cfg.ports) serve({ fetch: app.fetch, port }, (i) => log("listening", { port: i.port, model: cfg.CHAT_MODEL }));
