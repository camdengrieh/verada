import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { countDistinct, count, sql } from "ponder";
import { type CauseTotalRow, type CauseTotalsRepo, mergeCauseTotals } from "./cause-totals";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { donation, liveDonation } = schema;

const num = (v: unknown) => Number(v ?? 0);

/** Weekly gifts (`donation`) and live-donation gifts (`live_donation`), grouped by cause id. */
export const causeTotalsRepo: CauseTotalsRepo = {
  async totals() {
    const weekly = await db
      .select({
        causeId: donation.causeId,
        donated: sql<string>`coalesce(sum(${donation.amount}), 0)`,
        donations: count(),
        tokens: countDistinct(donation.token),
      })
      .from(donation)
      .groupBy(donation.causeId);
    const live = await db
      .select({
        causeId: liveDonation.causeId,
        donated: sql<string>`coalesce(sum(${liveDonation.amount}), 0)`,
        donations: count(),
        tokens: countDistinct(liveDonation.token),
      })
      .from(liveDonation)
      .groupBy(liveDonation.causeId);
    const rows = (r: typeof weekly): CauseTotalRow[] =>
      r.map((x) => ({ causeId: x.causeId, donated: BigInt(x.donated), donations: num(x.donations), tokens: num(x.tokens) }));
    return mergeCauseTotals(rows(weekly), rows(live));
  },
};
