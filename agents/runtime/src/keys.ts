import { readFile } from "node:fs/promises";
import { createClient } from "@1claw/sdk";
import type { AgentRecord } from "./scheduler.js";

/** Secrets the runtime itself needs, by vault path. */
export const RUNTIME_SECRETS = { ANTHROPIC_API_KEY: "runtime/anthropic-api-key", GITHUB_TOKEN: "runtime/github-token" } as const;

/**
 * Fills each missing RUNTIME_SECRETS variable from the vault, using the runtime's 1Claw token.
 * Returns the names it set (never the values). A secret that is absent is left unset.
 */
export async function loadRuntimeSecrets(o: {
  env: NodeJS.ProcessEnv;
  vaultId?: string;
  baseUrl: string;
  read?: (vaultId: string, path: string, token: string) => Promise<string | null>;
}): Promise<string[]> {
  const token = o.env.ONECLAW_AGENT_TOKEN_FILE ? (await readFile(o.env.ONECLAW_AGENT_TOKEN_FILE, "utf8")).trim() : o.env.ONECLAW_AGENT_TOKEN;
  if (!o.vaultId || !token) return [];
  const read =
    o.read ??
    (async (vaultId, path, t) => {
      const r = await createClient({ baseUrl: o.baseUrl, token: t }).secrets.get(vaultId, path);
      return r.data?.value ?? null;
    });
  const set: string[] = [];
  for (const [name, path] of Object.entries(RUNTIME_SECRETS)) {
    if (o.env[name]) continue;
    const v = await read(o.vaultId, path, token).catch(() => null);
    if (v) {
      o.env[name] = v;
      set.push(name);
    }
  }
  return set;
}

/**
 * Each curator agent's 1Claw API key, read at run time and never written to disk or logs.
 *  1. `ONECLAW_API_KEY_<AGENT>` (e.g. ONECLAW_API_KEY_RELIEF), for an operator running locally;
 *  2. otherwise the 1Claw vault `ONECLAW_KEYS_VAULT_ID` at the agent's `apiKeyPath`, read with the
 *     runtime's own agent token (ONECLAW_AGENT_TOKEN, minted by 1Claw; or the file in
 *     ONECLAW_AGENT_TOKEN_FILE, re-read each time so a renewed token is picked up).
 */
export function apiKeys(o: {
  env?: NodeJS.ProcessEnv;
  vaultId?: string;
  baseUrl: string;
  read?: (vaultId: string, path: string, token: string) => Promise<string | null>;
}) {
  const env = o.env ?? process.env;
  const read =
    o.read ??
    (async (vaultId, path, token) => {
      const client = createClient({ baseUrl: o.baseUrl, token });
      const r = await client.secrets.get(vaultId, path);
      return r.data?.value ?? null;
    });
  return async (a: AgentRecord): Promise<string | null> => {
    const local = env[`ONECLAW_API_KEY_${a.agent.toUpperCase().replace(/-/g, "_")}`];
    if (local) return local;
    if (!o.vaultId) return null;
    const token = env.ONECLAW_AGENT_TOKEN_FILE ? (await readFile(env.ONECLAW_AGENT_TOKEN_FILE, "utf8")).trim() : env.ONECLAW_AGENT_TOKEN;
    if (!token) return null;
    return read(o.vaultId, a.apiKeyPath, token);
  };
}
