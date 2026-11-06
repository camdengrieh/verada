import type { Hex, PublicClient } from "viem";
import type { CatalogOrgResult } from "./catalog";

/**
 * Per-cause donor leaderboards: the coins (Varada tokens, through weekly and live payouts) and the
 * wallets (any address donating directly to an Endaoment org) that gave most to one cause category
 * in a time window. Everything here is public on-chain data; a wallet is shown by address, or by
 * its primary name when that name is a `varada.eth` subname.
 */

/** Weekly (`donation`) and live (`live_donation`) payouts, grouped by token and cause. */
export interface CoinDonationRow {
  token: Hex;
  causeId: Hex;
  amount: bigint;
  donations: number;
}

/** Direct org donations (`org_donation`), grouped by donor and cause, without Varada's own payouts. */
export interface WalletDonationRow {
  donor: Hex;
  causeId: Hex;
  amount: bigint;
  donations: number;
}

export interface TokenInfo {
  address: Hex;
  name: string;
  symbol: string;
  /** ENS label under the parent (`<label>.varada.eth`), when registered. */
  label: string | null;
}

export interface DonorsRepo {
  /** `from <= timestamp < to`. */
  coins(from: bigint, to: bigint): Promise<CoinDonationRow[]>;
  /** `from <= timestamp < to`; rows in a transaction that is a Varada payout are excluded. */
  wallets(from: bigint, to: bigint): Promise<WalletDonationRow[]>;
  tokens(addresses: Hex[]): Promise<TokenInfo[]>;
  /** The weekly governor's epoch clock, or null before it is indexed. */
  clock(): Promise<{ epochZeroStart: bigint; epochLength: bigint } | null>;
}

/** Primary names of addresses, kept only when they are subnames of the parent. */
export interface NameLookup {
  names(addresses: Hex[]): Promise<Map<string, string>>;
}

export interface Ranked<K> {
  key: K;
  donated: bigint;
  donations: number;
  /** Distinct catalogue orgs in the cause that received from this donor. */
  orgs: number;
}

/** Keeps rows whose cause is a catalogue org in `categorySlug` (and `regionSlug`, if given). */
export function inCause<T extends { causeId: Hex }>(
  rows: T[],
  orgOf: (causeId: Hex) => CatalogOrgResult | undefined,
  categorySlug: string,
  regionSlug?: string,
): T[] {
  return rows.filter((r) => {
    const o = orgOf(r.causeId);
    if (!o || !o.categories.includes(categorySlug)) return false;
    return !regionSlug || o.regions.includes(regionSlug);
  });
}

/** Sums rows per key; largest total first, ties by key so pages are stable. */
export function rankBy<T extends { causeId: Hex; amount: bigint; donations: number }>(
  rows: T[],
  keyOf: (r: T) => string,
  exclude: ReadonlySet<string> = new Set(),
): Ranked<string>[] {
  const by = new Map<string, { donated: bigint; donations: number; orgs: Set<string> }>();
  for (const r of rows) {
    const key = keyOf(r).toLowerCase();
    if (exclude.has(key)) continue;
    const cur = by.get(key) ?? { donated: 0n, donations: 0, orgs: new Set<string>() };
    cur.donated += r.amount;
    cur.donations += r.donations;
    cur.orgs.add(r.causeId.toLowerCase());
    by.set(key, cur);
  }
  return [...by.entries()]
    .map(([key, v]) => ({ key, donated: v.donated, donations: v.donations, orgs: v.orgs.size }))
    .filter((r) => r.donated > 0n)
    .sort((a, b) => (a.donated !== b.donated ? (a.donated > b.donated ? -1 : 1) : a.key < b.key ? -1 : 1));
}

export interface DonorWindow {
  from: bigint;
  to: bigint;
  /** The epoch the window covers, or null for a trailing window. */
  epoch: bigint | null;
}

/** Epoch `n` when given (needs the clock), else the trailing `days` up to `now`. */
export function donorWindow(
  q: { epoch?: bigint; days?: number },
  clock: { epochZeroStart: bigint; epochLength: bigint } | null,
  now: bigint,
): DonorWindow | null {
  if (q.epoch !== undefined) {
    if (!clock) return null;
    const from = clock.epochZeroStart + q.epoch * clock.epochLength;
    return { from, to: from + clock.epochLength, epoch: q.epoch };
  }
  const days = BigInt(q.days ?? 7);
  return { from: now - days * 86_400n, to: now + 1n, epoch: null };
}

/** The ENSv2 Universal Resolver on mainnet. */
export const UNIVERSAL_RESOLVER = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as const;

/**
 * Reverse resolution through the Universal Resolver (which checks that the name resolves back to
 * the address), keeping only `*.parent` names. Answers, including "no name", are cached for
 * `ttlMs`; lookups that fail are not.
 */
export function varadaNameLookup(
  client: Pick<PublicClient, "getEnsName"> | null,
  parent: string,
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): NameLookup {
  const ttl = opts.ttlMs ?? 60 * 60 * 1000;
  const max = opts.maxEntries ?? 5000;
  const now = opts.now ?? Date.now;
  const suffix = `.${parent.toLowerCase()}`;
  const cache = new Map<string, { name: string | null; at: number }>();
  return {
    async names(addresses) {
      const out = new Map<string, string>();
      if (!client) return out;
      await Promise.all(
        [...new Set(addresses.map((a) => a.toLowerCase()))].map(async (a) => {
          const hit = cache.get(a);
          let name: string | null;
          if (hit && now() - hit.at < ttl) name = hit.name;
          else {
            try {
              const n = await client.getEnsName({ address: a as Hex, universalResolverAddress: UNIVERSAL_RESOLVER });
              name = n && n.toLowerCase().endsWith(suffix) ? n.toLowerCase() : null;
            } catch {
              // An RPC failure is not cached: the address shows unnamed this time and is retried.
              return;
            }
            if (cache.size >= max) cache.delete(cache.keys().next().value as string);
            cache.set(a, { name, at: now() });
          }
          if (name) out.set(a, name);
        }),
      );
      return out;
    },
  };
}
