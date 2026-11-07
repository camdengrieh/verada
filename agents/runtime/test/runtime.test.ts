import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ChatRequest, INSTRUCTIONS, REFUSAL_REPLY, answer, rateLimiter, systemFor } from "../src/chat.js";
import { readConfig } from "../src/config.js";
import { contextCache, isCause, loadCauseContext, type CauseContext } from "../src/context.js";
import { apiKeys } from "../src/keys.js";
import { commandArgv, curatorPrompt, dueNow, runEnv, scheduler, slotMinutes, type RunRecord, type ScheduledAgent } from "../src/scheduler.js";
import { clientOf, createServer } from "../src/server.js";

const ctx = (label = "hunger"): CauseContext => ({ label, agent: null, report: null, donors: null, text: JSON.stringify({ cause: label }) });

describe("chat request", () => {
  it("accepts alternating turns ending with the user", () => {
    expect(ChatRequest.safeParse({ messages: [{ role: "user", content: "hi" }] }).success).toBe(true);
    expect(ChatRequest.safeParse({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }).success).toBe(true);
    expect(ChatRequest.safeParse({ messages: [{ role: "assistant", content: "a" }] }).success).toBe(false);
    expect(ChatRequest.safeParse({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }).success).toBe(false);
    expect(ChatRequest.safeParse({ messages: [{ role: "user", content: "x".repeat(4001) }] }).success).toBe(false);
    expect(ChatRequest.safeParse({ messages: Array.from({ length: 21 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x" })) }).success).toBe(false);
  });

  it("puts the stable instructions first and caches through the cause's data", () => {
    const s = systemFor(ctx());
    expect(s[0]).toEqual({ type: "text", text: INSTRUCTIONS });
    expect(s[1]?.text).toContain("<cause_data>");
    expect(s[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(INSTRUCTIONS).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // nothing volatile in the cached prefix
  });
});

describe("answer", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const fake = (res: object) => {
    const create = vi.fn(async () => ({ model: "claude-opus-5-5", usage, ...res }));
    return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
  };

  it("asks Claude with the default fallback and low effort, and returns the text", async () => {
    const { client, create } = fake({ stop_reason: "end_turn", content: [{ type: "text", text: "Food banks in the Sahel. " }] });
    const a = await answer(client, ctx(), { messages: [{ role: "user", content: "who is ranked first?" }] }, { model: "claude-opus-5-5", effort: "low" });
    expect(a).toMatchObject({ reply: "Food banks in the Sahel.", stopReason: "end_turn", usage: { cacheRead: 900 } });
    const req = (create.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(req).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "low" }, max_tokens: 4096 });
  });

  it("checks for a refusal before reading content", async () => {
    const { client } = fake({ stop_reason: "refusal", content: [] });
    expect((await answer(client, ctx(), { messages: [{ role: "user", content: "x" }] }, { model: "m", effort: "low" })).reply).toBe(REFUSAL_REPLY);
  });
});

describe("rate limiter", () => {
  it("limits per minute and per day", () => {
    let t = 0;
    const limit = rateLimiter(2, 3, () => t);
    expect(limit("a").ok).toBe(true);
    expect(limit("a").ok).toBe(true);
    expect(limit("a")).toMatchObject({ ok: false, retryAfterSeconds: 60 });
    expect(limit("b").ok).toBe(true);
    t = 61_000;
    expect(limit("a").ok).toBe(true);
    expect(limit("a").ok).toBe(false); // the day's 3 are used
  });
});

describe("server", () => {
  const mk = (over: Partial<Parameters<typeof createServer>[0]> = {}) =>
    createServer({
      context: async (l) => ctx(l),
      ask: async (c) => ({ reply: `about ${c.label}`, stopReason: "end_turn", model: "m", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
      allowedOrigins: ["https://varada.eth.limo"],
      limit: rateLimiter(100, 100),
      ...over,
    });
  const post = (app: ReturnType<typeof mk>, label: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/chat/${label}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const msg = { messages: [{ role: "user", content: "hello" }] };

  it("answers any cause, for any number of users", async () => {
    const r = await post(mk(), "Water", msg);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cause: "water", reply: "about water", truncated: false });
  });

  it("validates, limits and reports upstream trouble", async () => {
    expect((await post(mk(), "mars", msg)).status).toBe(404);
    expect((await post(mk(), "water", { messages: [] })).status).toBe(400);
    const limited = mk({ limit: rateLimiter(1, 10) });
    expect((await post(limited, "water", msg, { "x-forwarded-for": "1.2.3.4" })).status).toBe(200);
    const r = await post(limited, "water", msg, { "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await post(mk({ context: async () => { throw new Error("down"); } }), "water", msg)).status).toBe(503);
    const busy = mk({ ask: async () => { throw new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()); } });
    expect((await post(busy, "water", msg)).status).toBe(503);
  });

  it("allows only the configured browser origins", async () => {
    const ok = await mk().request("/chat/water", { method: "OPTIONS", headers: { origin: "https://varada.eth.limo", "access-control-request-method": "POST" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://varada.eth.limo");
    const no = await mk().request("/chat/water", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    expect(clientOf(undefined)).toBe("unknown");
  });
});

describe("cause context", () => {
  it("loads the agent, its latest report and donors; a missing agent is not an error", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/api/agents/hunger")) return Response.json({ label: "hunger", reports: [{ epoch: "7" }] });
      if (url.includes("/reports/7")) return Response.json({ title: "week 7" });
      if (url.includes("/donors")) return Response.json({ coins: [] });
      return new Response("", { status: 404 });
    };
    const c = await loadCauseContext("https://ix.example", "hunger", fetchFn);
    expect(c.report).toEqual({ title: "week 7" });
    expect(calls).toContain("/api/agents/hunger/reports/7");
    const none = await loadCauseContext("https://ix.example", "water", fetchFn);
    expect(none.agent).toBeNull();
    expect(none.text).toContain('"latestReport":null');
    expect((await loadCauseContext(undefined, "water", fetchFn)).text).toContain("not live yet");
    expect(isCause("water")).toBe(true);
    expect(isCause("nope")).toBe(false);
  });

  it("caches per cause and retries after a failure", async () => {
    let t = 0;
    let n = 0;
    const get = contextCache(async (l) => {
      n++;
      if (n === 2) throw new Error("down");
      return ctx(l);
    }, 1000, () => t);
    await get("hunger");
    await get("hunger");
    expect(n).toBe(1);
    t = 2000;
    await expect(get("hunger")).rejects.toThrow("down");
    await get("hunger");
    expect(n).toBe(3);
  });
});

describe("scheduler", () => {
  const sched: ScheduledAgent[] = [
    { agent: "relief", causes: ["disaster", "hunger"], cron: "0 6 * * *", next: [{ agent: "relief", cause: "hunger", day: 1, date: "2026-11-09" }] },
    { agent: "housing", causes: ["homeless", "poverty"], cron: "30 6 * * *", next: [{ agent: "housing", cause: "poverty", day: 1, date: "2026-11-09" }] },
    { agent: "youth", causes: ["children", "education"], cron: "0 7 * * *", next: [{ agent: "youth", cause: "education", day: 2, date: "2026-11-10" }] },
  ];
  const at = (iso: string) => new Date(iso);

  it("starts only agents due today, after their time, not yet run", () => {
    expect(slotMinutes("30 6 * * *")).toBe(390);
    expect(dueNow(sched, [], at("2026-11-09T05:59:00Z"))).toEqual([]);
    expect(dueNow(sched, [], at("2026-11-09T06:10:00Z"))).toEqual([{ agent: "relief", cause: "hunger" }]);
    expect(dueNow(sched, [], at("2026-11-09T08:00:00Z")).map((j) => j.agent)).toEqual(["relief", "housing"]);
    const done = [{ date: "2026-11-09", agent: "relief" } as RunRecord];
    expect(dueNow(sched, done, at("2026-11-09T08:00:00Z")).map((j) => j.agent)).toEqual(["housing"]);
  });

  it("runs each due agent once, sequentially, with its own key", async () => {
    let history: RunRecord[] = [];
    const runs: string[] = [];
    const s = scheduler({
      repoDir: "/repo",
      schedule: async () => sched,
      agents: async () => [
        { agent: "relief", oneClawAgentId: "id-r", apiKeyPath: "agents/relief/api-key" },
        { agent: "housing", oneClawAgentId: "id-h", apiKeyPath: "agents/housing/api-key" },
      ],
      apiKey: async (a) => (a.agent === "housing" ? null : `key-${a.agent}`),
      run: async (a, cause, key) => {
        runs.push(`${a.agent}:${cause}:${key}`);
        return { exitCode: 0, timedOut: false, tail: "done" };
      },
      state: { load: async () => [...history], save: async (r) => { history = r; } },
      now: () => at("2026-11-09T09:00:00Z"),
      log: () => {},
    });
    const first = await s.tick();
    expect(runs).toEqual(["relief:hunger:key-relief"]);
    expect(first.map((r) => [r.agent, r.status])).toEqual([["relief", "ok"], ["housing", "no-key"]]);
    expect(await s.tick()).toEqual([]); // both recorded for today
  });

  it("builds the command and an env carrying only this agent's key", () => {
    expect(commandArgv("claude -p {prompt} --output-format json", curatorPrompt("relief"))).toEqual([
      "claude",
      ["-p", "run the curator skill for agent relief", "--output-format", "json"],
    ]);
    const env = runEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "a", ONECLAW_AGENT_TOKEN: "t", ONECLAW_AGENT_TOKEN_FILE: "/f", ONECLAW_API_KEY_HOUSING: "h", CHAT_MODEL: "m", AGENTS_VAULT_ID: "v" },
      { agent: "relief", oneClawAgentId: "id-r", apiKeyPath: "p" },
      "key-r",
    );
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "a", ONECLAW_AGENT_ID: "id-r", ONECLAW_API_KEY: "key-r" });
  });
});

describe("api keys", () => {
  it("prefers a local env key, else reads the vault with the runtime token", async () => {
    const read = vi.fn(async () => "vault-key");
    const rec = { agent: "mind", oneClawAgentId: "x", apiKeyPath: "agents/mind/api-key" };
    expect(await apiKeys({ env: { ONECLAW_API_KEY_MIND: "local" }, baseUrl: "https://api.1claw.co", read })(rec)).toBe("local");
    expect(await apiKeys({ env: { ONECLAW_AGENT_TOKEN: "tok" }, vaultId: "v1", baseUrl: "https://api.1claw.co", read })(rec)).toBe("vault-key");
    expect(read).toHaveBeenCalledWith("v1", "agents/mind/api-key", "tok");
    expect(await apiKeys({ env: {}, vaultId: "v1", baseUrl: "https://api.1claw.co", read })(rec)).toBeNull();
  });
});

describe("config", () => {
  it("reads the environment with safe defaults", () => {
    const c = readConfig({ INDEXER_URL: "https://ix.example/" });
    expect(c).toMatchObject({ INDEXER_URL: "https://ix.example", CHAT_MODEL: "claude-opus-5-5", CHAT_EFFORT: "low", schedulerEnabled: false, PORT: 8000 });
    expect(c.allowedOrigins).toContain("https://varada.eth.limo");
    expect(readConfig({}).INDEXER_URL).toBeUndefined();
    expect(() => readConfig({ INDEXER_URL: "not a url" })).toThrow();
  });
});

describe("runtime secrets", () => {
  it("fills missing variables from the vault with the runtime token, never overriding", async () => {
    const { loadRuntimeSecrets } = await import("../src/keys.js");
    const env: NodeJS.ProcessEnv = { ONECLAW_AGENT_TOKEN: "tok", GITHUB_TOKEN: "already" };
    const read = vi.fn(async (_v: string, path: string) => (path === "runtime/anthropic-api-key" ? "sk-test" : "other"));
    expect(await loadRuntimeSecrets({ env, vaultId: "v", baseUrl: "https://api.1claw.co", read })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.GITHUB_TOKEN).toBe("already");
    expect(await loadRuntimeSecrets({ env: {}, vaultId: "v", baseUrl: "x", read })).toEqual([]);
  });
});
