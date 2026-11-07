import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isAddress, type Address } from "viem";
import { createL2Proxy, type L2Proxy } from "./l2proxy.js";
import { answerCcip, CcipRequestError } from "./ccip.js";
import type { RootReader } from "./root.js";
import { orgView, type BuildSet } from "./store.js";

export interface AppOptions {
  builds: () => BuildSet;
  root: RootReader;
  /** When set, CCIP requests whose `sender` is another contract are refused. */
  resolver?: Address;
  /** Optimism proof proxy behind `/l2` (default: the public Unruggable gateways, 3 s budget). */
  l2?: L2Proxy;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  // CCIP-Read clients (wallets, dapps) call from any origin; everything here is public and read-only.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));

  const ccip = async (c: Context, sender: string | undefined, data: string | undefined) => {
    // The Swarm-style URL template has no {sender}; when one is given, check it.
    if (sender !== undefined) {
      if (!isAddress(sender, { strict: false })) return c.json({ message: "invalid sender" }, 400);
      if (opts.resolver && sender.toLowerCase() !== opts.resolver.toLowerCase()) {
        return c.json({ message: "unknown sender" }, 404);
      }
    }
    let out;
    try {
      out = answerCcip(opts.builds(), data ?? "", await opts.root.get());
    } catch (e) {
      if (e instanceof CcipRequestError) return c.json({ message: e.message }, 400);
      throw e;
    }
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: out.data });
  };

  // EIP-3668: URLs containing {data} are fetched with GET; others are POSTed {sender, data}.
  const file = (c: Context) => c.req.param("file")!.replace(/\.json$/, "");
  app.get("/ccip/:sender/:file", (c) => ccip(c, c.req.param("sender"), file(c)));
  app.get("/ccip/:file", (c) => ccip(c, undefined, file(c)));
  const post = async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { sender?: unknown; data?: unknown } | null;
    return ccip(c, typeof body?.sender === "string" ? body.sender : undefined, typeof body?.data === "string" ? body.data : undefined);
  };
  app.post("/ccip", post);
  app.post("/ccip/:sender/:file", post);
  // Last-resort Optimism "proof": always 0x, so the resolver falls back to the Merkle root. The
  // static form (`/l2-fallback.json?d={data}`) matches the file the Swarm export writes.
  const l2Fallback = (c: Context) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: "0x" });
  };
  app.get("/l2-fallback.json", l2Fallback);
  app.get("/l2-fallback/:sender/:file", l2Fallback);
  app.post("/l2-fallback", l2Fallback);

  // Optimism proof proxy: `/l2/{sender}/{data}.json` (and POST {sender, data}). It asks the public
  // Unruggable gateways within a budget and answers "0x" when none responds, which sends the
  // resolver to its Merkle fallback. Forged proofs are harmless: the on-chain verifier rejects them.
  const l2 = opts.l2 ?? createL2Proxy();
  const l2Answer = async (c: Context, sender: string | undefined, data: string | undefined) => {
    if (!sender || !isAddress(sender, { strict: false })) return c.json({ message: "invalid sender" }, 400);
    if (opts.resolver && sender.toLowerCase() !== opts.resolver.toLowerCase()) {
      return c.json({ message: "unknown sender" }, 404);
    }
    if (!data || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return c.json({ message: "invalid data" }, 400);
    const r = await l2.prove(sender, data);
    if (r.upstream) c.header("X-L2-Upstream", r.upstream);
    c.header("Cache-Control", r.data === "0x" ? "no-store" : "public, max-age=30");
    return c.json({ data: r.data });
  };
  app.get("/l2/:sender/:file", (c) => l2Answer(c, c.req.param("sender"), file(c)));
  const l2Post = async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { sender?: unknown; data?: unknown } | null;
    return l2Answer(c, typeof body?.sender === "string" ? body.sender : undefined, typeof body?.data === "string" ? body.data : undefined);
  };
  app.post("/l2", l2Post);
  app.post("/l2/:sender/:file", l2Post);

  app.get("/orgs", (c) => {
    const b = opts.builds().newest;
    const category = c.req.query("category")?.trim() || undefined;
    const region = c.req.query("region")?.trim() || undefined;
    const q = c.req.query("q")?.trim().toLowerCase() || undefined;
    const sort = c.req.query("sort") ?? "rank";
    if (sort !== "rank" && sort !== "name") return c.json({ message: "sort must be rank or name" }, 400);
    const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
    const cursorRaw = c.req.query("cursor");
    const offset = cursorRaw === undefined ? 0 : Number(cursorRaw);
    if (!Number.isInteger(offset) || offset < 0) return c.json({ message: "invalid cursor" }, 400);

    const list = sort === "name" ? b.byName : b.byRank;
    const page = [];
    let matched = 0;
    for (const o of list) {
      if (category && !o.categories.includes(category)) continue;
      if (region && !o.regions.includes(region)) continue;
      if (q && !b.matches(o, q)) continue;
      if (matched >= offset && page.length < limit) page.push(orgView(o));
      matched++;
    }
    const next = offset + page.length;
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      namesRoot: b.namesRoot,
      total: matched,
      orgs: page,
      nextCursor: next < matched ? String(next) : null,
    });
  });

  app.get("/orgs/:label", (c) => {
    const o = opts.builds().newest.byLabel.get(c.req.param("label").toLowerCase());
    if (!o) return c.json({ message: "not found" }, 404);
    c.header("Cache-Control", "public, max-age=60");
    return c.json(orgView(o));
  });

  app.get("/health", async (c) => {
    const set = opts.builds();
    const onchainRoot = await opts.root.get();
    return c.json({
      ok: true,
      onchainRoot,
      serving: set.select(onchainRoot).namesRoot,
      builds: set.builds.map((b) => ({ namesRoot: b.namesRoot, shardBits: b.names.bits, builtAt: b.builtAt, orgs: b.byLabel.size, source: b.source })),
    });
  });

  return app;
}
