/**
 * AWS Lambda (Function URL) entry point for the Optimism proof proxy alone. It is stateless and
 * holds no catalogue: the Merkle fallback is served from Swarm. Routes match the Node gateway:
 *   GET  /l2/{sender}/{data}.json   POST /l2  {sender, data}   → first Unruggable proof or "0x"
 *   GET  /l2-fallback.json          GET /l2-fallback/{sender}/{data}.json   POST /l2-fallback → "0x"
 *   GET  /health
 * Env:
 *   ORG_RESOLVER     when set, requests from other senders get 404
 *   L2_UPSTREAMS     comma-separated upstream gateways (default: the public Unruggable ones)
 *   L2_BUDGET_MS     per-request budget (default 3000)
 * CORS is configured on the Function URL.
 */
import { createL2Proxy, DEFAULT_L2_BUDGET_MS, DEFAULT_L2_UPSTREAMS } from "./l2proxy.js";

interface UrlEvent {
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const upstreams = process.env.L2_UPSTREAMS
  ? process.env.L2_UPSTREAMS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_L2_UPSTREAMS;
const budgetMs = Number(process.env.L2_BUDGET_MS ?? DEFAULT_L2_BUDGET_MS);
const resolver = process.env.ORG_RESOLVER?.trim().toLowerCase() || undefined;
const proxy = createL2Proxy({ upstreams, budgetMs });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

const json = (statusCode: number, body: unknown, cache = "no-store"): UrlResult => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": cache },
  body: JSON.stringify(body),
});

function parseBody(e: UrlEvent): { sender?: unknown; data?: unknown } {
  if (!e.body) return {};
  try {
    const raw = e.isBase64Encoded ? Buffer.from(e.body, "base64").toString("utf8") : e.body;
    return JSON.parse(raw) as { sender?: unknown; data?: unknown };
  } catch {
    return {};
  }
}

export async function prove(sender: unknown, data: unknown): Promise<UrlResult> {
  if (typeof sender !== "string" || !ADDRESS.test(sender)) return json(400, { message: "invalid sender" });
  if (resolver && sender.toLowerCase() !== resolver) return json(404, { message: "unknown sender" });
  if (typeof data !== "string" || !HEX.test(data)) return json(400, { message: "invalid data" });
  const r = await proxy.prove(sender, data);
  const res = json(200, { data: r.data }, r.data === "0x" ? "no-store" : "public, max-age=30");
  if (r.upstream) res.headers["x-l2-upstream"] = r.upstream;
  return res;
}

export async function handler(e: UrlEvent): Promise<UrlResult> {
  const method = e.requestContext?.http?.method ?? "GET";
  const path = e.rawPath ?? "/";
  if (path === "/health") return json(200, { ok: true, upstreams: upstreams.length, budgetMs });
  if (path === "/l2-fallback.json" || path === "/l2-fallback" || path.startsWith("/l2-fallback/")) {
    return json(200, { data: "0x" });
  }
  const m = /^\/l2\/([^/]+)\/([^/]+?)(?:\.json)?$/.exec(path);
  if (method === "GET" && m) return prove(m[1], m[2]);
  if (method === "POST" && (path === "/l2" || path === "/" || m)) {
    const b = parseBody(e);
    return prove(b.sender, b.data);
  }
  return json(404, { message: "not found" });
}
