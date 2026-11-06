import { db } from "ponder:api";
import * as rawSchema from "ponder:schema";
import { asc, desc, eq } from "ponder";
import type { LiveRepo } from "./live";

const { default: _interop, ...schema } = rawSchema as typeof rawSchema & { default?: unknown };
const { liveToken, liveSchedule, liveCauseSchedule, liveCauseTotal, liveDonation } = schema;

export const liveRepo: LiveRepo = {
  async getLiveToken(t) {
    const [row] = await db.select().from(liveToken).where(eq(liveToken.token, t)).limit(1);
    if (!row) return null;
    const [schedule] = await db.select().from(liveSchedule).where(eq(liveSchedule.token, t)).limit(1);
    const causeSchedule = await db.select().from(liveCauseSchedule).where(eq(liveCauseSchedule.token, t)).orderBy(asc(liveCauseSchedule.fromRotation));
    const causeTotals = await db.select().from(liveCauseTotal).where(eq(liveCauseTotal.token, t));
    return { token: row, schedule: schedule ?? null, causeSchedule, causeTotals };
  },
  async donations(t, limit) {
    return db.select().from(liveDonation).where(eq(liveDonation.token, t)).orderBy(desc(liveDonation.timestamp)).limit(limit);
  },
};
