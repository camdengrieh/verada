import { DonorsSchema, type Donors, type Report } from "./report.js";

/** The indexer's `GET /api/agents/:label/donors` body, as far as the snapshot needs it. */
interface IndexerDonors {
  window: { from: string; to: string };
  coins: { token: string; symbol: string | null; ensName: string | null; donated: string; donations: number }[];
  wallets: { address: string; ensName: string | null; donated: string; donations: number }[];
}

/** Converts the indexer's leaderboard into the report's `donors` snapshot (validated). */
export function donorsSnapshot(body: IndexerDonors): Donors {
  return DonorsSchema.parse({
    from: Number(body.window.from),
    to: Number(body.window.to),
    coins: body.coins.map((c) => ({
      token: c.token,
      symbol: c.symbol ?? "",
      ...(c.ensName ? { ensName: c.ensName } : {}),
      donated: c.donated,
      donations: c.donations,
    })),
    wallets: body.wallets.map((w) => ({
      address: w.address,
      ...(w.ensName ? { ensName: w.ensName } : {}),
      donated: w.donated,
      donations: w.donations,
    })),
  });
}

/** Fetches the trailing-window leaderboard for one agent label from the indexer. */
export async function fetchDonors(indexerUrl: string, label: string, opts: { days?: number; limit?: number; fetch?: typeof fetch } = {}): Promise<Donors> {
  const f = opts.fetch ?? globalThis.fetch;
  const url = `${indexerUrl.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(label)}/donors?days=${opts.days ?? 7}&limit=${opts.limit ?? 10}`;
  const res = await f(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`indexer returned ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
  return donorsSnapshot((await res.json()) as IndexerDonors);
}

/**
 * The report with the indexer snapshot as its `donors`, or without `donors` when no snapshot is
 * given: donor figures only ever come from the indexer, never from the report file itself.
 */
export function withDonors(report: Report, snapshot: Donors | undefined): Report {
  const { donors: _ignored, ...rest } = report;
  return snapshot ? { ...rest, donors: DonorsSchema.parse(snapshot) } : (rest as Report);
}
