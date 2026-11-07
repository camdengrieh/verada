import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileP = promisify(execFile);

/**
 * Daily curator scheduler. The rotation itself lives in packages/curator (`varada-curator
 * curators`): each of the ten agents has a daily time and runs one of its two causes every 3 days.
 * This loop asks the CLI for today's schedule, and when an agent's time has come and it has not
 * run today, it starts one Claude Code run of the curator skill with that agent's 1Claw
 * credentials. Runs are sequential, so only one agent signs at a time.
 */

export interface ScheduledAgent {
  agent: string;
  causes: string[];
  /** `m h * * *` in UTC. */
  cron: string;
  next: { agent: string; cause: string; day: number; date: string }[];
}

export interface AgentRecord {
  agent: string;
  oneClawAgentId: string;
  apiKeyPath: string;
}

export interface RunRecord {
  date: string;
  agent: string;
  cause: string;
  status: "ok" | "failed" | "timeout" | "no-key";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  /** Last lines of the run's output, for the logs. */
  tail: string;
}

export interface SchedulerDeps {
  repoDir: string;
  /** Today's schedule from `varada-curator curators`. */
  schedule(): Promise<ScheduledAgent[]>;
  agents(): Promise<AgentRecord[]>;
  apiKey(a: AgentRecord): Promise<string | null>;
  run(a: AgentRecord, cause: string, apiKey: string): Promise<{ exitCode: number | null; timedOut: boolean; tail: string }>;
  state: { load(): Promise<RunRecord[]>; save(r: RunRecord[]): Promise<void> };
  now(): Date;
  log(msg: string, extra?: Record<string, unknown>): void;
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10);
const minutesOf = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

export function slotMinutes(cron: string): number {
  const [m, h] = cron.trim().split(/\s+/).map(Number);
  if (m === undefined || h === undefined || !Number.isInteger(m) || !Number.isInteger(h)) throw new Error(`not a daily cron: ${cron}`);
  return h * 60 + m;
}

/** The agents that should start now: due today (per the rotation), past their time, not yet run today. */
export function dueNow(schedule: ScheduledAgent[], done: RunRecord[], now: Date): { agent: string; cause: string }[] {
  const today = utcDate(now);
  return schedule
    .filter((s) => s.next[0]?.date === today && minutesOf(now) >= slotMinutes(s.cron))
    .filter((s) => !done.some((r) => r.date === today && r.agent === s.agent))
    .sort((a, b) => slotMinutes(a.cron) - slotMinutes(b.cron))
    .map((s) => ({ agent: s.agent, cause: s.next[0]!.cause }));
}

export function scheduler(deps: SchedulerDeps) {
  let busy = false;
  async function tick(): Promise<RunRecord[]> {
    if (busy) return [];
    busy = true;
    const ran: RunRecord[] = [];
    try {
      const [schedule, agents, history] = await Promise.all([deps.schedule(), deps.agents(), deps.state.load()]);
      for (const job of dueNow(schedule, history, deps.now())) {
        const rec = agents.find((a) => a.agent === job.agent);
        const startedAt = deps.now();
        const base = { date: utcDate(startedAt), agent: job.agent, cause: job.cause, startedAt: startedAt.toISOString() };
        let r: RunRecord;
        const key = rec ? await deps.apiKey(rec).catch(() => null) : null;
        if (!rec || !key) {
          r = { ...base, status: "no-key", exitCode: null, finishedAt: deps.now().toISOString(), tail: rec ? "API key unavailable" : "agent not in agents/curators.json" };
        } else {
          deps.log("curator run started", { agent: job.agent, cause: job.cause });
          const out = await deps.run(rec, job.cause, key);
          r = { ...base, status: out.timedOut ? "timeout" : out.exitCode === 0 ? "ok" : "failed", exitCode: out.exitCode, finishedAt: deps.now().toISOString(), tail: out.tail };
        }
        deps.log("curator run finished", { agent: r.agent, cause: r.cause, status: r.status, exitCode: r.exitCode });
        history.push(r);
        ran.push(r);
        // Keep 60 days of history.
        await deps.state.save(history.slice(-600));
      }
    } finally {
      busy = false;
    }
    return ran;
  }
  return { tick };
}

// ------------------------------------------------------------------ real dependencies

/** Run a command with an argument list (no shell), with a timeout; keeps the last `maxBytes` of output (default 4 KB). */
export function exec(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes?: number }): Promise<{ exitCode: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const max = o.maxBytes ?? 4096;
    const keep = (d: Buffer) => {
      tail = (tail + d.toString("utf8")).slice(-max);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, tail: `${tail}\n${e.message}`.slice(-4096) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, tail });
    });
  });
}

/** `claude -p {prompt} ...` -> argv, with `{prompt}` as one argument. */
export function commandArgv(template: string, prompt: string): [string, string[]] {
  const parts = template.trim().split(/\s+/).map((p) => (p === "{prompt}" ? prompt : p));
  const [cmd, ...args] = parts;
  if (!cmd) throw new Error("CURATOR_COMMAND is empty");
  return [cmd, args];
}

export const curatorPrompt = (agent: string) => `run the curator skill for agent ${agent}`;

/** Secrets that the curator run must not inherit (it gets only its own agent's 1Claw key). */
const STRIP = /^(ONECLAW_API_KEY_|ONECLAW_AGENT_TOKEN|ONECLAW_TOKEN|ONECLAW_KEYS_VAULT_ID|CHAT_)/;

export function runEnv(base: NodeJS.ProcessEnv, a: AgentRecord, apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.test(k)) env[k] = v;
  env.ONECLAW_AGENT_ID = a.oneClawAgentId;
  env.ONECLAW_API_KEY = apiKey;
  return env;
}

export function fileState(path: string) {
  return {
    async load(): Promise<RunRecord[]> {
      try {
        return JSON.parse(await readFile(path, "utf8")) as RunRecord[];
      } catch {
        return [];
      }
    },
    async save(r: RunRecord[]) {
      await writeFile(path, JSON.stringify(r, null, 1));
    },
  };
}

export async function cliSchedule(repoDir: string, now: Date): Promise<ScheduledAgent[]> {
  const { stdout } = await execFileP("node", [join(repoDir, "packages/curator/bin/varada-curator.mjs"), "curators", "--at", now.toISOString()], {
    cwd: repoDir,
    timeout: 60_000,
    maxBuffer: 1 << 20,
  });
  return JSON.parse(stdout) as ScheduledAgent[];
}

export async function recordAgents(repoDir: string): Promise<AgentRecord[]> {
  const rec = JSON.parse(await readFile(join(repoDir, "agents/curators.json"), "utf8")) as { agents: AgentRecord[] };
  return rec.agents;
}
