import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ChatRequest, answer, rateLimiter, type ChatAnswer, type ChatOptions } from "./chat.js";
import { CAUSE_LABELS, isCause, type CauseContext } from "./context.js";

export interface ServerDeps {
  context(label: string): Promise<CauseContext>;
  ask(ctx: CauseContext, req: ChatRequest): Promise<ChatAnswer>;
  allowedOrigins: string[];
  limit: ReturnType<typeof rateLimiter>;
  /** Whether the chat has its Anthropic key (for /health). */
  chatReady?: () => boolean;
  /** Scheduler status for /health (null when the scheduler is off). */
  scheduler?: () => unknown;
}

/** The client's address: first hop of X-Forwarded-For (1Claw's proxy sets it), else "unknown". */
export function clientOf(xff: string | undefined): string {
  return xff?.split(",")[0]?.trim() || "unknown";
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  app.use(
    "/chat/*",
    cors({
      origin: (origin) => (deps.allowedOrigins.includes("*") || deps.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 86_400,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, causes: CAUSE_LABELS.length, chat: deps.chatReady?.() ?? true, scheduler: deps.scheduler?.() ?? null }));
  app.get("/causes", (c) => c.json({ causes: CAUSE_LABELS }));

  app.post("/chat/:label", async (c) => {
    const label = c.req.param("label").toLowerCase();
    if (!isCause(label)) return c.json({ error: "unknown_cause" }, 404);
    const body = ChatRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request", issues: body.error.issues.map((i) => i.message) }, 400);
    const allowed = deps.limit(clientOf(c.req.header("x-forwarded-for")));
    if (!allowed.ok) {
      c.header("retry-after", String(allowed.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    let ctx: CauseContext;
    try {
      ctx = await deps.context(label);
    } catch {
      return c.json({ error: "data_unavailable" }, 503);
    }
    try {
      const a = await deps.ask(ctx, body.data);
      return c.json({ cause: label, reply: a.reply, truncated: a.stopReason === "max_tokens" });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
        c.header("retry-after", "30");
        return c.json({ error: "busy" }, 503);
      }
      if (e instanceof Anthropic.APIError) return c.json({ error: "upstream_error" }, 502);
      throw e;
    }
  });

  return app;
}

export function claudeAsker(client: Anthropic, o: ChatOptions) {
  return (ctx: CauseContext, req: ChatRequest) => answer(client, ctx, req, o);
}
