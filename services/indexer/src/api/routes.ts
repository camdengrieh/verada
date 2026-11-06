import { createHash } from "node:crypto";
import {
  ALL_CATEGORIES_MASK,
  ALL_REGIONS_MASK,
  CATEGORIES,
  REGIONS,
  categoryMaskOf,
  categorySlugs,
  agentByLabel,
  effectiveBallotSize,
  MAX_BALLOT_OPTIONS,
  isValidLabel,
  regionBySlug,
  regionMaskOf,
  regionSlugs,
} from "@verada/sdk";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Hex } from "viem";
import { z } from "zod";
import { ActivityBus } from "./bus";
import type { ApiConfig } from "./config";
import { type Cursor, decodeCursor, decodeOffset, encodeCursor, encodeOffset } from "./cursor";
import { pickProofs, verifyReport, type AgentsRepo, type ReportFetcher } from "./agents";
import type { CatalogStore } from "./catalog";
import type { CauseSearch } from "./search";
import {
  corsMiddleware,
  RateLimiter,
  rateLimitMiddleware,
  readOnlyGate,
} from "./security";
import { currentEpochAt, resolveSchedule } from "./shortlist";
import { toProposal } from "./takeover";
import { type LiveRepo, toLiveView } from "./live";
import {
  type HolderLabel,
  type MarketRepo,
  fillDays,
  priceFromSqrt,
  shareOf,
  toHolderViews,
  toTradeView,
  windowOf,
} from "./market";
import type { FacilitatorClient } from "@x402/core/server";
import { mountX402 } from "./x402";
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  type BallotSizeSettings,
  type CausePoolAttributionRow,
  type EpochClock,
  type EpochRow,
  type Repo,
  type TokenRow,
  activityCursor,
} from "./types";

export interface ApiDeps {
  repo: Repo;
  search: CauseSearch;
  config: ApiConfig;
  /** Published cause catalogue; `/api/catalog/*` answers 503 while it is not loaded. */
  catalog?: CatalogStore;
  /** Curator agents; `/api/agents/*` answers 503 without it. */
  agents?: AgentsRepo;
  /** Live-donation tokens; `/api/live/*` answers 503 without it. */
  live?: LiveRepo;
  /** Trades and holders; `/api/tokens/:address/{trades,holders,market}` answer 503 without it. */
  market?: MarketRepo;
  /** Weekly reports on Swarm. */
  reports?: ReportFetcher;
  bus?: ActivityBus;
  limiter?: RateLimiter;
  /** x402 facilitators; built from `config.x402` when omitted (tests inject fakes). */
  x402Facilitators?: FacilitatorClient[];
  now?: () => number;
}

const CACHE = {
  list: "public, max-age=0, s-maxage=5, stale-while-revalidate=15",
  detail: "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
  stats: "public, max-age=0, s-maxage=15, stale-while-revalidate=30",
  causes: "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
  catalog: "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  search: "public, max-age=30, s-maxage=300, stale-while-revalidate=600",
  none: "no-store",
} as const;

const serialize = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Sends JSON with Cache-Control and a weak ETag; honours If-None-Match. */
function send(c: Context, body: unknown, cache: string, status: 200 | 404 = 200) {
  const text = serialize(body);
  c.header("Cache-Control", cache);
  if (status === 200 && cache !== CACHE.none) {
    const etag = `W/"${createHash("sha1").update(text).digest("base64url").slice(0, 27)}"`;
    c.header("ETag", etag);
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").some((t) => t.trim() === etag)) return c.body(null, 304);
  }
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(text, status);
}

const bad = (c: Context, issues: { path: string; message: string }[]) => {
  c.header("Cache-Control", CACHE.none);
  return c.json({ error: "invalid_request", issues }, 400);
};

const blank = (v: unknown) => (v === "" ? undefined : v);
const limitSchema = z.preprocess(blank, z.coerce.number().int().min(1).max(100).default(25));
const cursorSchema = z.preprocess(blank, z.string().max(400).optional());
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

function parse<T extends z.ZodTypeAny>(c: Context, schema: T, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true as const, data: r.data as z.infer<T> };
  return {
    ok: false as const,
    res: bad(
      c,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    ),
  };
}

function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null };
}

const ListQuery = z.object({ cursor: cursorSchema, limit: limitSchema });

const ActivityQuerySchema = ListQuery.extend({
  token: z.preprocess(blank, addressSchema.optional()),
  kind: z.preprocess(
    blank,
    z
      .string()
      .max(400)
      .optional()
      .transform((s, ctx) => {
        if (!s) return undefined;
        const kinds = [...new Set(s.split(",").map((k) => k.trim()).filter(Boolean))];
        const invalid = kinds.filter((k) => !(ACTIVITY_KINDS as readonly string[]).includes(k));
        if (invalid.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `unknown kind; expected one of ${ACTIVITY_KINDS.join(", ")}`,
          });
          return z.NEVER;
        }
        return kinds as ActivityKind[];
      }),
  ),
});

const SearchQuery = z.object({
  q: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(2, "at least 2 characters").max(100)),
  cursor: cursorSchema,
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(25).default(10)),
});

const slugList = (known: readonly { slug: string }[], what: string) =>
  z.preprocess(
    blank,
    z
      .string()
      .max(600)
      .optional()
      .transform((s, ctx) => {
        if (!s) return undefined;
        const slugs = [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];
        const unknown = slugs.filter((x) => !known.some((k) => k.slug === x));
        if (unknown.length > 0) {
          ctx.addIssue({ code: "custom", message: `unknown ${what}: ${unknown.join(", ")}` });
          return z.NEVER;
        }
        return slugs;
      }),
  );

const FocusQuery = z.object({
  categories: slugList(CATEGORIES, "category"),
  regions: slugList(REGIONS, "region"),
});

const CatalogSearchQuery = FocusQuery.extend({
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  offset: z.preprocess(blank, z.coerce.number().int().min(0).max(1_000_000).default(0)),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(50).default(20)),
});

const EntriesQuery = z.object({
  at: z
    .string()
    .max(2000)
    .transform((s, ctx) => {
      const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length === 0 || parts.length > 100) {
        ctx.addIssue({ code: "custom", message: "1 to 100 bucket:index pairs" });
        return z.NEVER;
      }
      const out: { bucket: number; index: number }[] = [];
      for (const p of parts) {
        const m = /^(\d{1,4}):(\d{1,10})$/.exec(p);
        if (!m) {
          ctx.addIssue({ code: "custom", message: `bad entry ${p}` });
          return z.NEVER;
        }
        out.push({ bucket: Number(m[1]), index: Number(m[2]) });
      }
      return out;
    }),
  /** Root of the catalogue version the ballot is built from; omitted: the main snapshot. */
  root: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase() as Hex)
    .optional(),
});

const CausesQuery = z.object({
  ids: z
    .string()
    .max(4000)
    .transform((s, ctx) => {
      const ids = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
      if (ids.length === 0 || ids.length > 50 || ids.some((x) => !/^0x[0-9a-f]{64}$/.test(x))) {
        ctx.addIssue({ code: "custom", message: "1 to 50 comma-separated 32-byte cause ids" });
        return z.NEVER;
      }
      return ids as `0x${string}`[];
    }),
});

const masksOf = (q: { categories?: string[]; regions?: string[] }) => ({
  categoryMask: q.categories ? categoryMaskOf(q.categories) : ALL_CATEGORIES_MASK,
  regionMask: q.regions ? regionMaskOf(q.regions) : ALL_REGIONS_MASK,
});

const EpochParam = z.string().regex(/^\d{1,18}$/, "must be a non-negative integer");
const ActiveTokensQuery = z.object({ sinceEpoch: EpochParam, sinceTime: EpochParam });
const ProposalParam = z.string().regex(/^\d{1,20}$/, "must be a non-negative integer");
/** uint256 poll scope (an epoch index or a proposal id). */
const ScopeParam = z.string().regex(/^\d{1,78}$/, "must be a non-negative integer");

/** Profile block of a token detail; null until the registry has registered the token. */
function profileOf(t: TokenRow, textRecords: { key: string; value: string }[]) {
  if (t.label === null) return null;
  return {
    label: t.label,
    labelhash: t.labelhash,
    controller: t.controller,
    editor: t.editor,
    logoRef: t.logoRef,
    contenthash: t.contenthash,
    suppressed: t.suppressed,
    registeredAt: t.registeredAt,
    textRecords: Object.fromEntries(textRecords.map((r) => [r.key, r.value])),
  };
}

/**
 * Epoch timing from the governor clock: `end` is exclusive. `snapshot` is the token's weight
 * snapshot for the epoch, `snapshotFor(token, epoch)`: the launch snapshot when the governor set
 * one for this epoch, else `start - 1`.
 */
function epochTiming(clock: EpochClock | null, n: bigint, launchSnapshot: bigint | null) {
  if (!clock) return { start: null, end: null, snapshot: launchSnapshot };
  const start = clock.epochZeroStart + n * clock.epochLength;
  return { start, end: start + clock.epochLength, snapshot: launchSnapshot ?? start - 1n };
}

/**
 * A token's ballot size: the protocol `cap`, the token's own `choice` (0 follows the cap) and the
 * epoch it applies from, and `size`, what its next unprepared ballot gets (`ballotSizeFor`,
 * assuming the scheme allows 32 options as `ZamaVotingScheme` does). A prepared epoch keeps the
 * size it was prepared with (`ballotSize` on the epoch).
 */
export function ballotSizeOf(s: BallotSizeSettings) {
  const cap = s.cap ?? MAX_BALLOT_OPTIONS;
  const choice = s.choice ?? 0;
  return { cap, choice, size: effectiveBallotSize({ cap, choice }), choiceEffectiveFrom: s.choiceEffectiveFrom };
}

export type OptionSource = "pinned" | "curated" | "rotation";

/**
 * Where each ballot option came from, by index: the governor places pins first, then curated
 * picks, then rotation draws. All null until the ballot is prepared (counts unknown).
 */
export function optionSources(row: EpochRow, count: number): (OptionSource | null)[] {
  const { prepared, pinnedCount: pinned, curatedCount: curated } = row;
  return Array.from({ length: count }, (_, i) => {
    if (!prepared || pinned === null || curated === null) return null;
    if (i < pinned) return "pinned";
    return i < pinned + curated ? "curated" : "rotation";
  });
}

/**
 * The epoch's cause pool: what was credited to it and from which accrual epochs, what is still
 * held (`pending`, zero once settled) and where fees earned in this epoch went when its own pool
 * was already settled (`carriedForward`).
 */
function causePoolOf(
  row: EpochRow,
  credited: CausePoolAttributionRow[],
  accrued: CausePoolAttributionRow[],
) {
  const settled = row.settledAmount;
  const left = settled === null ? row.causeAttributed : row.causeAttributed - settled;
  return {
    attributed: row.causeAttributed,
    pending: left > 0n ? left : 0n,
    settledAmount: settled,
    settledAt: row.settledAt,
    accruals: credited.map((a) => ({
      accrualEpoch: a.accrualEpoch,
      causeAmount: a.causeAmount,
      parts: a.parts,
    })),
    carriedForward: accrued
      .filter((a) => a.epoch !== a.accrualEpoch)
      .map((a) => ({ epoch: a.epoch, causeAmount: a.causeAmount, parts: a.parts })),
  };
}

export function createApi(deps: ApiDeps): Hono {
  const { repo, search, config } = deps;
  const nowSeconds = () => BigInt(Math.floor((deps.now ?? Date.now)() / 1000));
  const limiter = deps.limiter ?? new RateLimiter(config.rateRps, config.rateBurst);
  const bus =
    deps.bus ??
    new ActivityBus(() => repo.listActivity({ limit: 100 }), config.ssePollMs);
  let sseClients = 0;

  const app = new Hono();
  app.use("*", corsMiddleware(config.corsOrigins));
  app.use("*", rateLimitMiddleware(limiter, config.trustProxyHops, config.rateBurst));
  app.use("/api/*", readOnlyGate(config.maxUrlLength));
  app.use("/x402/*", readOnlyGate(config.maxUrlLength));

  app.onError((err, c) => {
    c.header("Cache-Control", CACHE.none);
    // Never echo internals; the detail stays in the server log.
    console.error("api error", err instanceof Error ? err.message : "unknown");
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => {
    c.header("Cache-Control", CACHE.none);
    return c.json({ error: "not_found" }, 404);
  });

  app.get("/api/health", (c) => send(c, { status: "ok" }, CACHE.none));

  // ---- paid data (x402); absent unless enabled
  mountX402(app, {
    config: config.x402,
    facilitators: deps.x402Facilitators,
    agents: deps.agents,
    reports: deps.reports,
    catalog: deps.catalog,
    ensParentName: config.ensParentName,
    serialize,
  });

  // ---- curator agents

  const agentsUnavailable = (c: Context) => {
    c.header("Cache-Control", CACHE.none);
    return c.json({ error: "agents_unavailable" }, 503);
  };
  const agentLabel = (c: Context) => {
    const label = c.req.param("label") ?? "";
    return agentByLabel(label) ? label.toLowerCase() : null;
  };
  const agentSummary = (a: import("./agents").AgentRow) => {
    const def = agentByLabel(a.label);
    return {
      categoryBit: a.categoryBit,
      category: def?.slug ?? null,
      name: def?.label ?? a.label,
      label: a.label,
      ensName: `${a.label}.agent.${config.ensParentName}`,
      agentId: a.agentId,
      signer: a.signer,
      vault: a.vault,
      active: a.active,
      description: a.description,
      walletLinked: a.walletLinked,
    };
  };

  app.get("/api/agents", async (c) => {
    if (!deps.agents) return agentsUnavailable(c);
    const rows = await deps.agents.listAgents();
    return send(
      c,
      {
        items: rows.map((r) => ({
          ...agentSummary(r.agent),
          totals: r.totals,
          latest: r.latest && { epoch: r.latest.epoch, reportRef: r.latest.reportRef, catalogVersion: r.latest.catalogVersion },
        })),
      },
      CACHE.list,
    );
  });

  app.get("/api/agents/:label", async (c) => {
    if (!deps.agents) return agentsUnavailable(c);
    const label = agentLabel(c);
    if (!label) return bad(c, [{ path: "label", message: "unknown agent label" }]);
    const a = await deps.agents.getAgentByLabel(label);
    if (!a) return send(c, { error: "not_found" }, CACHE.none, 404);
    const [totals, reports, donors, gifts] = await Promise.all([
      deps.agents.totals(a.categoryBit),
      deps.agents.reports(a.categoryBit, 52),
      deps.agents.creditedDonations(a.categoryBit, 100),
      deps.agents.gifts(a.categoryBit, 100),
    ]);
    const latest = reports[0];
    const curations = latest ? await deps.agents.curations(a.categoryBit, latest.epoch) : [];
    return send(
      c,
      {
        ...agentSummary(a),
        totals,
        reports: reports.map((r) => ({ epoch: r.epoch, reportRef: r.reportRef, catalogVersion: r.catalogVersion, submittedAt: r.submittedAt })),
        latestCurations: curations.map((x) => ({ regionBit: x.regionBit, count: x.count, weight: x.weight, picksRoot: x.picksRoot })),
        donors: donors.map((d) => ({ donor: d.donor, amount: d.amount, timestamp: d.timestamp, txHash: d.txHash })),
        gifts,
      },
      CACHE.detail,
    );
  });

  const loadReport = async (c: Context) => {
    if (!deps.agents || !deps.reports) return { res: agentsUnavailable(c) } as const;
    const label = agentLabel(c);
    if (!label) return { res: bad(c, [{ path: "label", message: "unknown agent label" }]) } as const;
    const e = parse(c, EpochParam, c.req.param("epoch"));
    if (!e.ok) return { res: e.res } as const;
    const a = await deps.agents.getAgentByLabel(label);
    if (!a) return { res: send(c, { error: "not_found" }, CACHE.none, 404) } as const;
    const epoch = BigInt(e.data);
    const reports = await deps.agents.reports(a.categoryBit, 520);
    const row = reports.find((r) => r.epoch === epoch);
    if (!row) return { res: send(c, { error: "not_found" }, CACHE.none, 404) } as const;
    const stored = await deps.reports.get(row.reportRef);
    if (!stored) return { res: send(c, { error: "report_unavailable" }, CACHE.none, 404) } as const;
    return { agent: a, epoch, row, stored, curations: await deps.agents.curations(a.categoryBit, epoch) } as const;
  };

  app.get("/api/agents/:label/reports/:epoch", async (c) => {
    const r = await loadReport(c);
    if ("res" in r) return r.res;
    const { report } = r.stored;
    return send(
      c,
      {
        agent: agentSummary(r.agent),
        epoch: r.epoch,
        reportRef: r.row.reportRef,
        catalogVersion: r.row.catalogVersion,
        title: report.title,
        intro: report.intro,
        generatedAt: report.generatedAt,
        regions: verifyReport(r.stored, r.curations),
      },
      CACHE.catalog,
    );
  });

  app.get("/api/agents/:label/picks/:epoch/:region", async (c) => {
    let region: string;
    try {
      region = regionBySlug(c.req.param("region")).slug;
    } catch {
      return bad(c, [{ path: "region", message: "unknown region" }]);
    }
    const r = await loadReport(c);
    if ("res" in r) return r.res;
    const proofs = pickProofs(r.stored, region);
    if (!proofs) return send(c, { error: "not_found" }, CACHE.none, 404);
    const chain = r.curations.find((x) => x.regionBit === regionBySlug(region).bit);
    if (!chain || chain.picksRoot.toLowerCase() !== proofs.picksRoot.toLowerCase()) {
      return send(c, { error: "report_mismatch" }, CACHE.none, 404);
    }
    return send(c, proofs, CACHE.catalog);
  });

  // ---- cause catalogue

  const unavailable = (c: Context) => {
    c.header("Cache-Control", CACHE.none);
    return c.json({ error: "catalog_unavailable" }, 503);
  };

  app.get("/api/catalog", (c) => {
    const cat = deps.catalog?.catalog();
    if (!cat) return unavailable(c);
    const { meta } = cat;
    return send(
      c,
      {
        root: meta.root,
        taxonomyVersion: meta.taxonomyVersion,
        builtAt: meta.builtAt,
        sourceAsOf: meta.sourceAsOf,
        orgs: meta.stats.orgs,
        entries: meta.stats.entries,
        categories: CATEGORIES.map((x) => ({ slug: x.slug, label: x.label, bit: x.bit, orgs: meta.stats.byCategory[x.slug] ?? 0 })),
        regions: REGIONS.map((x) => ({ slug: x.slug, label: x.label, bit: x.bit, orgs: meta.stats.byRegion[x.slug] ?? 0 })),
        bucketSizes: meta.bucketSizes,
      },
      CACHE.catalog,
    );
  });

  app.get("/api/catalog/search", (c) => {
    const p = parse(c, CatalogSearchQuery, c.req.query());
    if (!p.ok) return p.res;
    const masks = masksOf(p.data);
    const r = deps.catalog?.search({ q: p.data.q, ...masks, offset: p.data.offset, limit: p.data.limit });
    if (!r) return unavailable(c);
    return send(c, { ...r, offset: p.data.offset, limit: p.data.limit }, CACHE.catalog);
  });

  app.get("/api/catalog/pool", (c) => {
    const p = parse(c, FocusQuery, c.req.query());
    if (!p.ok) return p.res;
    const masks = masksOf(p.data);
    const r = deps.catalog?.pool(masks.categoryMask, masks.regionMask);
    if (!r) return unavailable(c);
    return send(c, { ...r, categoryMask: masks.categoryMask, regionMask: masks.regionMask }, CACHE.catalog);
  });

  app.get("/api/catalog/entries", (c) => {
    const p = parse(c, EntriesQuery, c.req.query());
    if (!p.ok) return p.res;
    if (p.data.root) {
      // A ballot built from a given version (a rotation round keeps the epoch-start one all week).
      const r = deps.catalog?.entriesOf(p.data.root, p.data.at);
      if (r === null || !deps.catalog) return unavailable(c);
      if (r === undefined) return send(c, { error: "catalog_root_unavailable" }, CACHE.none, 404);
      return send(c, { root: p.data.root, items: r }, CACHE.catalog);
    }
    const cat = deps.catalog?.catalog();
    const r = deps.catalog?.entries(p.data.at);
    if (!r || !cat) return unavailable(c);
    return send(c, { root: cat.meta.root, items: r }, CACHE.catalog);
  });

  app.get("/api/catalog/causes", (c) => {
    const p = parse(c, CausesQuery, c.req.query());
    if (!p.ok) return p.res;
    const r = deps.catalog?.causes(p.data.ids);
    if (!r) return unavailable(c);
    return send(c, { items: r }, CACHE.catalog);
  });

  app.get("/api/catalog/orgs/:id", (c) => {
    const id = c.req.param("id");
    if (!/^(0x[0-9a-fA-F]{64}|\d{2}-?\d{7}|[0-9a-fA-F-]{36})$/.test(id)) {
      return bad(c, [{ path: "id", message: "must be a 32-byte org id, an EIN or an Endaoment id" }]);
    }
    const cat = deps.catalog?.catalog();
    if (!cat) return unavailable(c);
    const r = deps.catalog!.org(id);
    if (!r) return send(c, { error: "not_found" }, CACHE.none, 404);
    return send(c, { root: cat.meta.root, ...r }, CACHE.catalog);
  });

  app.get("/api/tokens", async (c) => {
    const p = parse(c, ListQuery, c.req.query());
    if (!p.ok) return p.res;
    let before: Cursor | undefined;
    if (p.data.cursor) {
      before = decodeCursor(p.data.cursor) ?? undefined;
      if (!before) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
    }
    const rows = await repo.listTokens({ before, limit: p.data.limit + 1 });
    const page = paginate(rows, p.data.limit, (t) =>
      encodeCursor({ t: t.createdAt.toString(), k: t.address }),
    );
    const totals = await repo.feeTotalsFor(page.items.map((t) => t.address));
    const byToken = new Map(totals.map((f) => [f.token, f]));
    return send(
      c,
      {
        items: page.items.map((t) => ({ ...t, feeTotals: byToken.get(t.address) ?? null })),
        nextCursor: page.nextCursor,
      },
      CACHE.list,
    );
  });

  const tokenDetail = async (c: Context, address: `0x${string}`) => {
    const found = await repo.getToken(address);
    if (!found) return send(c, { error: "not_found" }, CACHE.none, 404);
    const current = currentEpochAt(found.clock, nowSeconds());
    const own = resolveSchedule(found.shortlist, current);
    return send(
      c,
      {
        ...found.token,
        feeTotals: found.feeTotals,
        profile: profileOf(found.token, found.textRecords),
        shortlist: own.inEffect.length > 0 ? own.inEffect : null,
        shortlistPending: own.pending,
        ballotSize: ballotSizeOf(found.ballotSize),
        focus: found.focus
          ? {
              categoryMask: found.focus.categoryMask,
              regionMask: found.focus.regionMask,
              categories: categorySlugs(found.focus.categoryMask),
              regions: regionSlugs(found.focus.regionMask),
            }
          : null,
      },
      CACHE.detail,
    );
  };

  app.get("/api/tokens/by-label/:label", async (c) => {
    const label = c.req.param("label");
    if (!isValidLabel(label)) {
      return bad(c, [{ path: "label", message: "must be a valid label ([a-z0-9-], 3-63 chars)" }]);
    }
    const address = await repo.findTokenByLabel(label);
    if (!address) return send(c, { error: "not_found" }, CACHE.none, 404);
    return tokenDetail(c, address);
  });

  app.get("/api/tokens/:address", async (c) => {
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    return tokenDetail(c, a.data);
  });

  app.get("/api/activity", async (c) => {
    const p = parse(c, ActivityQuerySchema, c.req.query());
    if (!p.ok) return p.res;
    let before: Cursor | undefined;
    if (p.data.cursor) {
      before = decodeCursor(p.data.cursor) ?? undefined;
      if (!before) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
    }
    const rows = await repo.listActivity({
      kinds: p.data.kind,
      token: p.data.token,
      before,
      limit: p.data.limit + 1,
    });
    const page = paginate(rows, p.data.limit, (i) => encodeCursor(activityCursor(i)));
    return send(c, page, CACHE.list);
  });

  app.get("/api/activity/stream", async (c) => {
    if (sseClients >= config.sseMaxClients) {
      c.header("Retry-After", "5");
      return c.json({ error: "too_many_streams" }, 503);
    }
    const lastId = c.req.header("last-event-id");
    let resume: Cursor | null = null;
    if (lastId) {
      resume = decodeCursor(lastId);
      if (!resume) return bad(c, [{ path: "Last-Event-ID", message: "invalid event id" }]);
    }
    const onlyToken = c.req.query("token");
    let tokenFilter: string | undefined;
    if (onlyToken) {
      const a = addressSchema.safeParse(onlyToken);
      if (!a.success) return bad(c, [{ path: "token", message: "must be a 20-byte hex address" }]);
      tokenFilter = a.data;
    }

    sseClients++;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let queue: import("./types").ActivityItem[] = [];
      let wake: (() => void) | null = null;
      const poke = () => {
        wake?.();
        wake = null;
      };
      const unsubscribe = bus.subscribe((items) => {
        queue.push(...items);
        poke();
      });
      stream.onAbort(poke);
      try {
        await stream.write("retry: 3000\n\n");
        if (resume) {
          const { items, gap } = await bus.since(resume);
          if (gap) await stream.writeSSE({ event: "reset", data: "{}" });
          queue = [...items, ...queue.filter((q) => !items.some((i) => i.id === q.id))];
        }
        const deadline = Date.now() + config.sseMaxAgeMs;
        while (!stream.aborted && !stream.closed && Date.now() < deadline) {
          const batch = queue;
          queue = [];
          for (const item of batch) {
            if (tokenFilter && item.token !== tokenFilter) continue;
            await stream.writeSSE({
              id: encodeCursor(activityCursor(item)),
              event: "activity",
              data: serialize(item),
            });
          }
          if (queue.length > 0) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
            const t = setTimeout(resolve, Math.min(config.sseHeartbeatMs, Math.max(1, deadline - Date.now())));
            t.unref?.();
          });
          if (queue.length === 0 && !stream.aborted) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe();
        sseClients--;
      }
    });
  });

  app.get("/api/causes", async (c) => {
    const rows = await repo.listCauses();
    return send(c, { items: rows, nextCursor: null }, CACHE.causes);
  });

  app.get("/api/causes/search", async (c) => {
    const p = parse(c, SearchQuery, c.req.query());
    if (!p.ok) return p.res;
    let offset = 0;
    if (p.data.cursor) {
      const o = decodeOffset(p.data.cursor);
      if (o === null) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
      offset = o;
    }
    let items;
    try {
      items = await search.search(p.data.q, offset, p.data.limit);
    } catch {
      c.header("Cache-Control", CACHE.none);
      return c.json({ error: "upstream_unavailable" }, 502);
    }
    const nextCursor = items.length === p.data.limit ? encodeOffset(offset + items.length) : null;
    return send(c, { items, nextCursor }, CACHE.search);
  });

  app.get("/api/epochs/:token", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const q = parse(c, ListQuery, c.req.query());
    if (!q.ok) return q.res;
    let before: bigint | undefined;
    if (q.data.cursor) {
      const d = decodeCursor(q.data.cursor);
      if (!d) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
      before = BigInt(d.t);
    }
    const rows = await repo.listEpochs(t.data, { before, limit: q.data.limit + 1 });
    const page = paginate(rows, q.data.limit, (e) => encodeCursor({ t: e.epoch.toString(), k: "e" }));
    return send(c, page, CACHE.list);
  });

  app.get("/api/epochs/:token/:epoch", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const e = parse(c, EpochParam, c.req.param("epoch"));
    if (!e.ok) return e.res;
    const n = BigInt(e.data);
    const found = await repo.getEpoch(t.data, n);
    if (!found) return send(c, { error: "not_found" }, CACHE.none, 404);
    const p = found.poll;
    return send(
      c,
      {
        ...found.epoch,
        ...epochTiming(found.clock, n, found.epoch.launchSnapshot),
        options: found.options,
        optionOrgIds: found.optionOrgIds,
        optionSources: optionSources(found.epoch, found.options.length),
        poll: p
          ? {
              opened: p.opened,
              closed: p.closed,
              isFinal: p.isFinal,
              optionCount: p.optionCount,
              counts: p.counts,
              ballotCount: p.ballotCount,
              scheme: p.scheme,
            }
          : null,
        donations: found.donations,
        causePool: causePoolOf(found.epoch, found.causePool, found.accrued),
      },
      CACHE.detail,
    );
  });

  app.get("/api/takeovers/:token", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const rows = await repo.listTakeovers(t.data, 100);
    const executions = await repo.takeoverExecutions(t.data);
    const now = nowSeconds();
    return send(c, { items: rows.map((r) => toProposal(r, now, executions)) }, CACHE.list);
  });

  app.get("/api/takeovers/:token/:id", async (c) => {
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const id = parse(c, ProposalParam, c.req.param("id"));
    if (!id.ok) return id.res;
    const row = await repo.getTakeover(BigInt(id.data));
    if (!row || row.token !== t.data) return send(c, { error: "not_found" }, CACHE.none, 404);
    const executions = await repo.takeoverExecutions(row.token);
    return send(c, toProposal(row, nowSeconds(), executions), CACHE.detail);
  });

  // ---- market data: trades, holders, hourly volume

  const marketUnavailable = (c: Context) => {
    c.header("Cache-Control", CACHE.none);
    return c.json({ error: "market_unavailable" }, 503);
  };
  // No trader filter: no route takes a viewer's address (docs/PRIVACY.md); "my trades" filter in
  // the browser or read the account through the account client.
  const TradesQuery = ListQuery.extend({
    side: z.preprocess(blank, z.enum(["buy", "sell"]).optional()),
  });
  const HoldersQuery = z.object({
    limit: limitSchema,
    /** `contracts` leaves out the pool, burn address and platform vaults (the creator stays). */
    exclude: z.preprocess(blank, z.enum(["none", "contracts"]).default("none")),
  });
  const MarketQuery = z.object({
    hours: z.preprocess(blank, z.coerce.number().int().min(1).max(168).default(24)),
  });
  const CONTRACT_LABELS = new Set<HolderLabel>(["pool", "burn", "vault"]);
  const contractsOf = (labels: Map<string, HolderLabel>) =>
    [...labels].filter(([, l]) => CONTRACT_LABELS.has(l)).map(([a]) => a as `0x${string}`);

  app.get("/api/tokens/:address/trades", async (c) => {
    if (!deps.market) return marketUnavailable(c);
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    const p = parse(c, TradesQuery, c.req.query());
    if (!p.ok) return p.res;
    let before: { t: bigint; k: string } | undefined;
    if (p.data.cursor) {
      const cur = decodeCursor(p.data.cursor);
      if (!cur) return bad(c, [{ path: "cursor", message: "invalid cursor" }]);
      before = { t: BigInt(cur.t), k: cur.k };
    }
    const [rows, m] = await Promise.all([
      deps.market.trades(a.data, { before, side: p.data.side, limit: p.data.limit + 1 }),
      deps.market.market(a.data),
    ]);
    const page = paginate(rows, p.data.limit, (r) => encodeCursor({ t: r.timestamp.toString(), k: r.id }));
    return send(
      c,
      {
        quote: m?.quote ?? null,
        quoteDecimals: m?.quoteDecimals ?? null,
        items: page.items.map((r) => toTradeView(r, m)),
        nextCursor: page.nextCursor,
      },
      CACHE.list,
    );
  });

  app.get("/api/tokens/:address/holders", async (c) => {
    if (!deps.market) return marketUnavailable(c);
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    const p = parse(c, HoldersQuery, c.req.query());
    if (!p.ok) return p.res;
    const [stat, labels] = await Promise.all([deps.market.holderStat(a.data), deps.market.labels(a.data)]);
    if (!stat) return send(c, { holders: 0, supply: 0n, items: [] }, CACHE.detail);
    const exclude = p.data.exclude === "contracts" ? contractsOf(labels) : [];
    const rows = await deps.market.topHolders(a.data, p.data.limit, exclude);
    return send(
      c,
      { holders: stat.holders, supply: stat.supply, items: toHolderViews(rows, stat.supply, labels) },
      CACHE.detail,
    );
  });

  app.get("/api/tokens/:address/holders/summary", async (c) => {
    if (!deps.market) return marketUnavailable(c);
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    const [stat, labels] = await Promise.all([deps.market.holderStat(a.data), deps.market.labels(a.data)]);
    if (!stat) return send(c, { error: "not_found" }, CACHE.none, 404);
    const now = BigInt(nowSeconds());
    const contracts = contractsOf(labels);
    const creator = [...labels].find(([, l]) => l === "creator")?.[0] as `0x${string}` | undefined;
    const [top, buckets, known, newHolders24h, days] = await Promise.all([
      deps.market.topHolders(a.data, 10, contracts),
      deps.market.buckets(a.data, stat.supply, contracts),
      deps.market.balancesOf(a.data, creator ? [...contracts, creator] : contracts),
      deps.market.newHolders(a.data, now - 86_400n),
      deps.market.holderDays(a.data, now - 30n * 86_400n),
    ]);
    const balanceOf = (pred: (l: HolderLabel | undefined) => boolean) =>
      known.filter((k) => pred(labels.get(k.account.toLowerCase()))).reduce((s, k) => s + k.balance, 0n);
    return send(
      c,
      {
        holders: stat.holders,
        newHolders24h,
        supply: stat.supply,
        transfers: stat.transfers,
        poolShare: shareOf(balanceOf((l) => l === "pool"), stat.supply),
        creatorShare: shareOf(balanceOf((l) => l === "creator"), stat.supply),
        contractShare: shareOf(balanceOf((l) => l !== undefined && CONTRACT_LABELS.has(l)), stat.supply),
        top10Share: shareOf(top.reduce((s, r) => s + r.balance, 0n), stat.supply),
        buckets: buckets.map((b) => ({ label: b.label, holders: b.holders, share: shareOf(b.balance, stat.supply) })),
        history: days.length ? fillDays(days, days[0]!.day, now) : [],
      },
      CACHE.detail,
    );
  });

  app.get("/api/tokens/:address/market", async (c) => {
    if (!deps.market) return marketUnavailable(c);
    const a = parse(c, addressSchema, c.req.param("address"));
    if (!a.ok) return a.res;
    const p = parse(c, MarketQuery, c.req.query());
    if (!p.ok) return p.res;
    const now = BigInt(nowSeconds());
    const since = now - (now % 3_600n) - BigInt(p.data.hours - 1) * 3_600n;
    const [m, stat, hours] = await Promise.all([
      deps.market.market(a.data),
      deps.market.tradeStat(a.data),
      deps.market.hours(a.data, since),
    ]);
    const price = (sqrt: bigint) =>
      m && m.quoteDecimals !== null ? priceFromSqrt(sqrt, m.tokenIsCurrency0, m.quoteDecimals) : null;
    return send(
      c,
      {
        quote: m?.quote ?? null,
        quoteDecimals: m?.quoteDecimals ?? null,
        price: stat ? price(stat.lastSqrtPriceX96) : null,
        lastTradeAt: stat?.lastTradeAt ?? null,
        lifetime: stat
          ? { trades: stat.trades, buys: stat.buys, sells: stat.sells, volumeQuote: stat.volumeQuote, volumeToken: stat.volumeToken }
          : null,
        window: { hours: p.data.hours, ...windowOf(hours) },
        hourly: hours.map((h) => ({ ...h, closePrice: price(h.closeSqrtPriceX96) })),
      },
      CACHE.list,
    );
  });

  // ---- live-donation tokens

  app.get("/api/live/:token", async (c) => {
    if (!deps.live) {
      c.header("Cache-Control", CACHE.none);
      return c.json({ error: "live_unavailable" }, 503);
    }
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const [found, donations] = await Promise.all([deps.live.getLiveToken(t.data), deps.live.donations(t.data, 50)]);
    if (!found) return send(c, { error: "not_found" }, CACHE.none, 404);
    return send(c, { ...toLiveView(found, nowSeconds()), recentDonations: donations }, CACHE.detail);
  });

  app.get("/api/polls/:governor/:token/:scope", async (c) => {
    const g = parse(c, addressSchema, c.req.param("governor"));
    if (!g.ok) return g.res;
    const t = parse(c, addressSchema, c.req.param("token"));
    if (!t.ok) return t.res;
    const sc = parse(c, ScopeParam, c.req.param("scope"));
    if (!sc.ok) return sc.res;
    const row = await repo.getPoll(g.data, t.data, BigInt(sc.data));
    if (!row) return send(c, { error: "not_found" }, CACHE.none, 404);
    return send(c, row, CACHE.detail);
  });

  app.get("/api/stats", async (c) => {
    const s = await repo.stats();
    return send(c, { decimals: 6, currency: "USDC", ...s }, CACHE.stats);
  });

  /**
   * Tokens with activity since `sinceEpoch` (fees credited to a pool of that epoch or later,
   * ballots cast in one, or a curation skip requested for one) or since `sinceTime` (pins changed,
   * or launched). Collected fees only: the keeper checks uncollected LP fees on chain, and Ponder's
   * `/status` for how far this listing is behind the chain. The keeper opens the
   * current epoch only for these; the rest are idle and open on demand.
   */
  app.get("/api/active-tokens", async (c) => {
    const q = parse(c, ActiveTokensQuery, c.req.query());
    if (!q.ok) return q.res;
    const items = await repo.activeTokens(BigInt(q.data.sinceEpoch), BigInt(q.data.sinceTime));
    return send(c, { sinceEpoch: q.data.sinceEpoch, sinceTime: q.data.sinceTime, items }, CACHE.list);
  });

  return app;
}
