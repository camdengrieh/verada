import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { and, count, desc, eq, gte, inArray, lt, sql } from "ponder";
import type { Hex } from "viem";
import type { CoinDonationRow, DonorsRepo, WalletDonationRow } from "./donors";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { donation, liveDonation, orgDonation, vaultGift, token, epochSchedule } = schema;

const num = (v: unknown) => Number(v ?? 0);

export const donorsRepo: DonorsRepo = {
  async coins(from, to) {
    const weekly = await db
      .select({ token: donation.token, causeId: donation.causeId, amount: sql<string>`coalesce(sum(${donation.amount}), 0)`, donations: count() })
      .from(donation)
      .where(and(gte(donation.timestamp, from), lt(donation.timestamp, to)))
      .groupBy(donation.token, donation.causeId);
    const live = await db
      .select({ token: liveDonation.token, causeId: liveDonation.causeId, amount: sql<string>`coalesce(sum(${liveDonation.amount}), 0)`, donations: count() })
      .from(liveDonation)
      .where(and(gte(liveDonation.timestamp, from), lt(liveDonation.timestamp, to)))
      .groupBy(liveDonation.token, liveDonation.causeId);
    return [...weekly, ...live].map(
      (r): CoinDonationRow => ({ token: r.token as Hex, causeId: r.causeId as Hex, amount: BigInt(r.amount), donations: num(r.donations) }),
    );
  },
  async wallets(from, to) {
    // Varada's own payouts reach the org in the same transaction as their Varada event.
    const payouts = sql`(select ${donation.txHash} from ${donation} union select ${liveDonation.txHash} from ${liveDonation} union select ${vaultGift.txHash} from ${vaultGift})`;
    const rows = await db
      .select({ donor: orgDonation.donor, causeId: orgDonation.causeId, amount: sql<string>`coalesce(sum(${orgDonation.amount}), 0)`, donations: count() })
      .from(orgDonation)
      .where(and(gte(orgDonation.timestamp, from), lt(orgDonation.timestamp, to), sql`${orgDonation.txHash} not in ${payouts}`))
      .groupBy(orgDonation.donor, orgDonation.causeId);
    return rows.map(
      (r): WalletDonationRow => ({ donor: r.donor as Hex, causeId: r.causeId as Hex, amount: BigInt(r.amount), donations: num(r.donations) }),
    );
  },
  async tokens(addresses) {
    if (addresses.length === 0) return [];
    const rows = await db
      .select({ address: token.address, name: token.name, symbol: token.symbol, label: token.label, suppressed: token.suppressed })
      .from(token)
      .where(inArray(token.address, addresses));
    return rows.map((r) => ({
      address: r.address as Hex,
      name: r.name,
      symbol: r.symbol,
      // A suppressed profile's label is not shown.
      label: r.suppressed ? null : (r.label ?? null),
    }));
  },
  async clock() {
    // The governor's schedule is a list of segments (`epochSchedule`); the donor window maths assumes
    // one uniform clock, so project the latest segment back to epoch 0. Exact for every epoch in that
    // segment (the current and future ones); earlier segments, if the schedule was ever changed, are
    // approximated.
    const [seg] = await db
      .select({ startEpoch: epochSchedule.startEpoch, startTime: epochSchedule.startTime, length: epochSchedule.length })
      .from(epochSchedule)
      .orderBy(desc(epochSchedule.startEpoch))
      .limit(1);
    if (!seg) return null;
    return { epochZeroStart: seg.startTime - seg.startEpoch * seg.length, epochLength: seg.length };
  },
};
