/** Public Unruggable Optimism gateways (the ones ENS's Optimism reverse resolver also lists). */
export const DEFAULT_L2_UPSTREAMS = [
  "https://optimism.gateway.unruggable.com",
  "https://lb.drpc.org/gateway/unruggable?network=optimism",
  "https://optimism.3668.io",
];
export const DEFAULT_L2_BUDGET_MS = 3_000;

export interface L2Proxy {
  /** First valid `data` from an upstream within the budget, else "0x" (the resolver then falls back). */
  prove(sender: string, data: string): Promise<{ data: string; upstream: string | null }>;
}

const isProof = (x: unknown): x is string => typeof x === "string" && /^0x([0-9a-fA-F]{64})+$/.test(x);

/**
 * Asks every upstream in parallel (EIP-3668 POST {sender, data}) and returns the first answer that
 * looks like an ABI-encoded proof. Wrong or forged proofs are harmless: the resolver's verifier
 * rejects them and falls back. The budget keeps wallet lookups fast while the public gateways are
 * slow or down.
 */
export function createL2Proxy(opts: { upstreams?: string[]; budgetMs?: number; fetch?: typeof fetch } = {}): L2Proxy {
  const upstreams = opts.upstreams ?? DEFAULT_L2_UPSTREAMS;
  const budget = opts.budgetMs ?? DEFAULT_L2_BUDGET_MS;
  const f = opts.fetch ?? fetch;
  return {
    async prove(sender, data) {
      if (!upstreams.length) return { data: "0x", upstream: null };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), budget);
      try {
        return await Promise.any(
          upstreams.map(async (u) => {
            const r = await f(u, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sender, data }),
              signal: ctl.signal,
            });
            const body = (await r.json().catch(() => null)) as { data?: unknown } | null;
            if (!r.ok || !isProof(body?.data)) throw new Error(`${u}: ${r.status}`);
            return { data: body!.data as string, upstream: u };
          }),
        );
      } catch {
        return { data: "0x", upstream: null };
      } finally {
        clearTimeout(timer);
        ctl.abort();
      }
    },
  };
}
