import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { count, countDistinct, eq, sql } from "ponder";
import { type CauseTotalRow, type CauseTotalsRepo, mergeCauseTotals } from "./cause-totals";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { donation, liveDonation, token } = schema;

const num = (v: unknown) => Number(v ?? 0);

/**
 * Weekly gifts (`donation`) and live-donation gifts (`live_donation`), grouped by cause id and by
 * the giving token's donation asset: a token's amounts are in its own asset (USDC 6 decimals, or
 * ETH 18), so the two are summed into separate columns and never added together here.
 */
export const causeTotalsRepo: CauseTotalsRepo = {
  async totals() {
    const weekly = await db
      .select({
        causeId: donation.causeId,
        asset: sql<number>`coalesce(${token.donationAsset}, 0)`,
        donated: sql<string>`coalesce(sum(${donation.amount}), 0)`,
        donations: count(),
        tokens: countDistinct(donation.token),
      })
      .from(donation)
      .leftJoin(token, eq(token.address, donation.token))
      .groupBy(donation.causeId, sql`coalesce(${token.donationAsset}, 0)`);
    const live = await db
      .select({
        causeId: liveDonation.causeId,
        asset: sql<number>`coalesce(${token.donationAsset}, 0)`,
        donated: sql<string>`coalesce(sum(${liveDonation.amount}), 0)`,
        donations: count(),
        tokens: countDistinct(liveDonation.token),
      })
      .from(liveDonation)
      .leftJoin(token, eq(token.address, liveDonation.token))
      .groupBy(liveDonation.causeId, sql`coalesce(${token.donationAsset}, 0)`);
    const rows = (r: typeof weekly): CauseTotalRow[] =>
      r.map((x) => {
        const amount = BigInt(x.donated);
        const eth = num(x.asset) === 1;
        return { causeId: x.causeId, donated: eth ? 0n : amount, donatedEth: eth ? amount : 0n, donations: num(x.donations), tokens: num(x.tokens) };
      });
    return mergeCauseTotals(rows(weekly), rows(live));
  },
};
