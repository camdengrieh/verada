import { z } from "zod";

const int = (def: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(def),
  );

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");
/** A USD amount as a decimal string, e.g. "0.01". */
const usd = (def: string) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, "must be a USD amount like 0.01").default(def),
  );

const optionalUsd = z.preprocess(
  (v) => (v === undefined || v === "" ? undefined : v),
  z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, "must be a USD amount like 0.01").optional(),
);
const caip2 = z.string().regex(/^eip155:\d+$/, "must be a CAIP-2 id like eip155:8453");

export type PaidRoute = "rankings" | "history" | "catalog" | "newsletters";

/** A USDC contract the exact EVM scheme has no default for, with its EIP-712 domain. */
export interface X402Asset {
  address: string;
  decimals: number;
  name: string;
  version: string;
}

/** One network x402 sales settle on, and the facilitator that settles it. */
export interface X402Network {
  name: "base" | "arc" | "optimism";
  /** CAIP-2 id, e.g. eip155:8453. */
  network: string;
  /** Platform treasury on this network. */
  payTo: string;
  /**
   * `url` unset (Base only): Coinbase CDP, authenticated with `cdpKeyId`/`cdpKeySecret`.
   * `token` is sent as `Authorization: Bearer` on /verify, /settle and /supported.
   */
  facilitator: { url?: string; token?: string; cdpKeyId?: string; cdpKeySecret?: string };
  /** Settlement asset when @x402/evm has no default USDC for the network (Optimism). */
  asset?: X402Asset;
  /** Prices on this network never go below this (USD decimal string), e.g. to cover a facilitator fee. */
  minPrice?: string;
}

export interface X402Config {
  enabled: boolean;
  /** In `accepts` order: Base, Arc, Optimism. */
  networks: X402Network[];
  /** USD decimal strings. */
  prices: Record<PaidRoute, string>;
}

/** Circle Facilitator Service; the client appends /verify, /settle and /supported. */
export const CIRCLE_FACILITATOR_URL = "https://api.circle.com/v1/facilitator/x402";
/** Dexter: keyless, gas-sponsored facilitator; lists x402 v2 `exact` on eip155:10 (checked 2026-11-07). */
export const DEXTER_FACILITATOR_URL = "https://x402.dexter.cash";

/**
 * Native USDC on OP Mainnet. EIP-712 name and version read on chain on 2026-11-07; the domain
 * separator they give matches the contract's `DOMAIN_SEPARATOR()`.
 */
export const OPTIMISM_USDC: X402Asset = {
  address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  decimals: 6,
  name: "USD Coin",
  version: "2",
};

const EnvSchema = z.object({
  /** Comma-separated origins and wildcard-suffix patterns. Empty means any origin (read-only GET). */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /** Token bucket: sustained requests per second per client IP. */
  RATE_LIMIT_RPS: int(5, 1, 10_000),
  /** Token bucket: burst capacity per client IP. */
  RATE_LIMIT_BURST: int(60, 1, 100_000),
  /** Number of trusted reverse-proxy hops (ALB = 1) when reading X-Forwarded-For. */
  TRUST_PROXY_HOPS: int(1, 0, 5),
  MAX_URL_LENGTH: int(2048, 128, 16_384),
  ENDAOMENT_API_URL: z.string().url().optional(),
  ENDAOMENT_API_KEY: z.string().optional(),
  /** Published cause catalogue: a directory or an http(s) base URL. */
  CATALOG_SOURCE: z.string().optional(),
  /** Swarm gateway for curator reports (`/bzz/<ref>/`). */
  SWARM_GATEWAY_URL: z.string().url().optional(),
  ENS_PARENT_NAME: z.string().default("varada.eth"),
  /**
   * Comma-separated addresses left out of the wallet donor leaderboards. Unset: Endaoment's own
   * operational senders (see DEFAULT_DONOR_EXCLUDE). Set to "none" to exclude nobody.
   */
  DONOR_EXCLUDE: z.string().optional(),
  SEARCH_CACHE_TTL_SECONDS: int(300, 1, 86_400),
  SEARCH_CACHE_MAX_ENTRIES: int(500, 10, 100_000),
  SSE_MAX_CLIENTS: int(500, 1, 100_000),
  SSE_POLL_MS: int(2_000, 100, 60_000),
  SSE_HEARTBEAT_MS: int(15_000, 100, 120_000),
  /** Streams are closed after this long; EventSource reconnects with Last-Event-ID. */
  SSE_MAX_AGE_MS: int(300_000, 100, 3_600_000),
  // ---- x402 paid data routes (/x402/v1/*); all revenue goes to the platform treasuries.
  X402_ENABLED: z.enum(["true", "false", "1", "0", ""]).optional(),
  // Base: Coinbase CDP settles (gas paid by CDP). CAIP-2 ids can be overridden (e.g. eip155:84532).
  X402_BASE_PAY_TO: address.optional(),
  X402_BASE_NETWORK: caip2.default("eip155:8453"),
  /** Base facilitator; unset uses Coinbase CDP (authenticated with CDP_API_KEY_ID/SECRET). */
  X402_BASE_FACILITATOR_URL: z.string().url().optional(),
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  X402_BASE_MIN_PRICE: optionalUsd,
  // Arc mainnet: Circle Facilitator Service settles (Arc settlements are final).
  X402_ARC_PAY_TO: address.optional(),
  X402_ARC_NETWORK: caip2.default("eip155:5042"),
  X402_ARC_FACILITATOR_URL: z.string().url().default(CIRCLE_FACILITATOR_URL),
  /** Circle API key, sent as a bearer token. Unset: Circle's keyless trial. */
  CIRCLE_API_KEY: z.string().optional(),
  X402_ARC_MIN_PRICE: optionalUsd,
  // Optimism: a third-party facilitator (neither CDP nor Circle settles on OP Mainnet); default Dexter.
  X402_OPTIMISM_PAY_TO: address.optional(),
  X402_OPTIMISM_NETWORK: caip2.default("eip155:10"),
  X402_OPTIMISM_FACILITATOR_URL: z.string().url().default(DEXTER_FACILITATOR_URL),
  X402_OPTIMISM_FACILITATOR_TOKEN: z.string().optional(),
  /** USDC on the Optimism network; default native USDC on OP Mainnet. */
  X402_OPTIMISM_USDC: address.default(OPTIMISM_USDC.address),
  /** E.g. the facilitator's per-settlement fee, so a sale never settles at a loss. */
  X402_OPTIMISM_MIN_PRICE: optionalUsd,
  X402_PRICE_RANKINGS: usd("0.01"),
  X402_PRICE_HISTORY: usd("0.10"),
  X402_PRICE_CATALOG: usd("0.50"),
  X402_PRICE_NEWSLETTERS: usd("0.02"),
});

export interface ApiConfig {
  corsOrigins: string[];
  rateRps: number;
  rateBurst: number;
  trustProxyHops: number;
  maxUrlLength: number;
  endaomentBaseUrl?: string;
  endaomentApiKey?: string;
  catalogSource?: string;
  swarmGatewayUrl?: string;
  ensParentName: string;
  /** Lowercase addresses never ranked as wallet donors. */
  donorExclude: string[];
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  sseMaxClients: number;
  ssePollMs: number;
  sseHeartbeatMs: number;
  sseMaxAgeMs: number;
  x402: X402Config;
}

export function readApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const e = EnvSchema.parse(env);
  return {
    corsOrigins: (e.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rateRps: e.RATE_LIMIT_RPS,
    rateBurst: e.RATE_LIMIT_BURST,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    maxUrlLength: e.MAX_URL_LENGTH,
    endaomentBaseUrl: e.ENDAOMENT_API_URL,
    endaomentApiKey: e.ENDAOMENT_API_KEY || undefined,
    catalogSource: e.CATALOG_SOURCE || undefined,
    swarmGatewayUrl: e.SWARM_GATEWAY_URL || undefined,
    ensParentName: e.ENS_PARENT_NAME,
    donorExclude: donorExcludeOf(e.DONOR_EXCLUDE),
    searchCacheTtlMs: e.SEARCH_CACHE_TTL_SECONDS * 1000,
    searchCacheMaxEntries: e.SEARCH_CACHE_MAX_ENTRIES,
    sseMaxClients: e.SSE_MAX_CLIENTS,
    ssePollMs: e.SSE_POLL_MS,
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    sseMaxAgeMs: e.SSE_MAX_AGE_MS,
    x402: x402Of(e),
  };
}

/**
 * Endaoment's own senders of `EntityDonationReceived`, found on mainnet on 2026-11-07 among the
 * top senders since block 23,000,000: `BaseTokenBucket` (Endaoment's base-token bucket contract)
 * and `ndao.eth` (Endaoment's DAO). They move funds that donors gave through Endaoment's own app,
 * so ranking them would credit Endaoment instead of the donor.
 */
export const DEFAULT_DONOR_EXCLUDE = [
  "0x711a9c250d4871c18ef00dbe5e7ee4610460b512",
  "0x9d5025b327e6b863e5050141c987d988c07fd8b2",
] as const;

function donorExcludeOf(v: string | undefined): string[] {
  if (v === undefined || v.trim() === "") return [...DEFAULT_DONOR_EXCLUDE];
  if (v.trim().toLowerCase() === "none") return [];
  const out = v.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const a of out) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`DONOR_EXCLUDE entry is not an address: ${a}`);
  return out;
}

function x402Of(e: z.infer<typeof EnvSchema>): X402Config {
  const enabled = e.X402_ENABLED === "true" || e.X402_ENABLED === "1";
  const networks: X402Network[] = [];
  if (e.X402_BASE_PAY_TO) {
    networks.push({
      name: "base",
      network: e.X402_BASE_NETWORK,
      payTo: e.X402_BASE_PAY_TO,
      facilitator: {
        url: e.X402_BASE_FACILITATOR_URL,
        cdpKeyId: e.CDP_API_KEY_ID || undefined,
        cdpKeySecret: e.CDP_API_KEY_SECRET || undefined,
      },
      minPrice: e.X402_BASE_MIN_PRICE,
    });
  }
  if (e.X402_ARC_PAY_TO) {
    networks.push({
      name: "arc",
      network: e.X402_ARC_NETWORK,
      payTo: e.X402_ARC_PAY_TO,
      facilitator: { url: e.X402_ARC_FACILITATOR_URL, token: e.CIRCLE_API_KEY || undefined },
      minPrice: e.X402_ARC_MIN_PRICE,
    });
  }
  if (e.X402_OPTIMISM_PAY_TO) {
    networks.push({
      name: "optimism",
      network: e.X402_OPTIMISM_NETWORK,
      payTo: e.X402_OPTIMISM_PAY_TO,
      facilitator: { url: e.X402_OPTIMISM_FACILITATOR_URL, token: e.X402_OPTIMISM_FACILITATOR_TOKEN || undefined },
      asset: { ...OPTIMISM_USDC, address: e.X402_OPTIMISM_USDC },
      minPrice: e.X402_OPTIMISM_MIN_PRICE,
    });
  }
  if (new Set(networks.map((n) => n.network)).size !== networks.length) {
    throw new Error("x402 networks must be distinct (check X402_*_NETWORK)");
  }
  if (enabled && networks.length === 0) {
    throw new Error("X402_ENABLED needs X402_BASE_PAY_TO, X402_ARC_PAY_TO or X402_OPTIMISM_PAY_TO");
  }
  return {
    enabled,
    networks,
    prices: {
      rankings: e.X402_PRICE_RANKINGS,
      history: e.X402_PRICE_HISTORY,
      catalog: e.X402_PRICE_CATALOG,
      newsletters: e.X402_PRICE_NEWSLETTERS,
    },
  };
}
