import { z } from "zod";

/**
 * Runtime configuration from the container environment. On a 1Claw runtime, plain values come
 * from `env_public`, secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN) from the vault, and
 * ONECLAW_AGENT_TOKEN is minted by 1Claw for the runtime's bound agent.
 */
const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  /** Indexer base URL (public `/api/agents/*` routes). */
  INDEXER_URL: z.string().url(),
  /** Origins allowed to call the chat API from a browser, comma-separated (`*` for any). */
  CHAT_ALLOWED_ORIGINS: z.string().default("https://varada.eth.limo,https://varada.eth.link"),
  /** Claude model for public chat. */
  CHAT_MODEL: z.string().default("claude-opus-5-5"),
  CHAT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** Requests per client IP per minute. */
  CHAT_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(6),
  /** Requests per client IP per day. */
  CHAT_RATE_PER_DAY: z.coerce.number().int().min(1).default(60),
  /** How long a cause's context (latest report, donors) is reused, in seconds. */
  CONTEXT_TTL_SECONDS: z.coerce.number().int().min(10).default(600),
  /** Run the daily curator scheduler in this container. */
  SCHEDULER_ENABLED: z.enum(["true", "false"]).default("false"),
  /** Repository checkout the curator skill runs in. */
  REPO_DIR: z.string().default(process.cwd()),
  /** The 1Claw vault holding each agent's API key at `agents/<agent>/api-key`. */
  ONECLAW_KEYS_VAULT_ID: z.string().optional(),
  ONECLAW_BASE_URL: z.string().url().default("https://api.1claw.co"),
  ONECLAW_AGENT_TOKEN: z.string().optional(),
  /** Command that runs one curator run; `{prompt}` is replaced. */
  CURATOR_COMMAND: z
    .string()
    .default("claude -p {prompt} --output-format json --allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task"),
  /** Longest a single curator run may take, in minutes. */
  CURATOR_TIMEOUT_MINUTES: z.coerce.number().int().min(5).default(120),
  /** Where the scheduler records which agent ran on which day. */
  STATE_FILE: z.string().default("/tmp/varada-runtime-state.json"),
});

export type RuntimeConfig = z.infer<typeof Env> & { allowedOrigins: string[]; schedulerEnabled: boolean };

export function readConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const e = Env.parse(env);
  return {
    ...e,
    INDEXER_URL: e.INDEXER_URL.replace(/\/+$/, ""),
    allowedOrigins: e.CHAT_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    schedulerEnabled: e.SCHEDULER_ENABLED === "true",
  };
}
