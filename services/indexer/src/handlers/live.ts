import type { Context, Event } from "ponder:registry";
import {
  claimsConversion,
  liveCauseTotal,
  liveDonation,
  liveFee,
  liveHeldRetry,
  liveMode,
  liveToken,
  liveVaultTotal,
} from "ponder:schema";
import type { Hex } from "viem";

// Live-donation mode: factory configuration, VeradaLiveHook, LiveDonationVault and the
// consolidator's claim conversions. RotationGovernor events live in ./rotation.

type Db = Context["db"];
type Meta = { block: { timestamp: bigint }; transaction: { hash: Hex } };

/** Upserts the live token row; the launch events of one token arrive in any order before `TokenCreated`. */
async function upsertToken(db: Db, token: Hex, e: Meta, patch: Partial<typeof liveToken.$inferInsert>) {
  if (await db.find(liveToken, { token })) {
    await db.update(liveToken, { token }).set(patch);
    return;
  }
  await db.insert(liveToken).values({
    token,
    baseFeeBps: null,
    launchSurchargeBps: null,
    surchargeDecaySeconds: null,
    launchTimestamp: null,
    threshold: null,
    initialCause: null,
    initialPeriod: null,
    registeredAt: null,
    quote: null,
    poolId: null,
    createdAt: e.block.timestamp,
    txHash: e.transaction.hash,
    ...patch,
  });
}

type CausePatch = {
  gross?: bigint;
  platform?: bigint;
  causeShare?: bigint;
  donated?: bigint;
  heldQuote?: bigint;
  deferReason?: Hex;
  at: bigint;
};

/** Adds to the (token, cause) ledger. `heldQuote` may be negative (a retry). */
async function bumpCause(db: Db, token: Hex, causeId: Hex, p: CausePatch) {
  const key = { token, causeId };
  const row = await db.find(liveCauseTotal, key);
  const credited = p.causeShare !== undefined;
  const donated = p.donated !== undefined;
  const next = {
    gross: (row?.gross ?? 0n) + (p.gross ?? 0n),
    platform: (row?.platform ?? 0n) + (p.platform ?? 0n),
    causeShare: (row?.causeShare ?? 0n) + (p.causeShare ?? 0n),
    credits: (row?.credits ?? 0) + (credited ? 1 : 0),
    donated: (row?.donated ?? 0n) + (p.donated ?? 0n),
    donations: (row?.donations ?? 0) + (donated ? 1 : 0),
    heldQuote: (row?.heldQuote ?? 0n) + (p.heldQuote ?? 0n),
    deferrals: (row?.deferrals ?? 0) + (p.deferReason !== undefined ? 1 : 0),
    lastDeferReason: p.deferReason ?? row?.lastDeferReason ?? null,
    lastCreditedAt: credited ? p.at : (row?.lastCreditedAt ?? null),
    lastDonatedAt: donated ? p.at : (row?.lastDonatedAt ?? null),
  };
  if (row) await db.update(liveCauseTotal, key).set(next);
  else await db.insert(liveCauseTotal).values({ ...key, ...next });
}

async function bumpVault(db: Db, p: { accrued?: bigint; withdrawn?: bigint; skim?: boolean }) {
  const id = "live_vault";
  const row = await db.find(liveVaultTotal, { id });
  const next = {
    platformAccrued: (row?.platformAccrued ?? 0n) + (p.accrued ?? 0n),
    platformWithdrawn: (row?.platformWithdrawn ?? 0n) + (p.withdrawn ?? 0n),
    withdrawals: (row?.withdrawals ?? 0) + (p.withdrawn !== undefined ? 1 : 0),
    skims: (row?.skims ?? 0) + (p.skim ? 1 : 0),
  };
  if (row) await db.update(liveVaultTotal, { id }).set(next);
  else await db.insert(liveVaultTotal).values({ id, ...next });
}

// ---- VeradaFactory

export async function onLiveModeConfigured({ event, context }: { event: Event<"Factory:LiveModeConfigured">; context: Context<"Factory:LiveModeConfigured"> }) {
  await context.db
    .insert(liveMode)
    .values({
      id: "factory",
      liveHook: event.args.liveHook,
      liveVault: event.args.liveVault,
      configuredAt: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
}

// ---- VeradaLiveHook

export async function onLiveTokenConfigured({ event, context }: { event: Event<"VeradaLiveHook:TokenConfigured">; context: Context<"VeradaLiveHook:TokenConfigured"> }) {
  const a = event.args;
  await upsertToken(context.db, a.token, event, {
    baseFeeBps: a.baseFeeBps,
    launchSurchargeBps: a.launchSurchargeBps,
    surchargeDecaySeconds: a.surchargeDecaySeconds,
    launchTimestamp: BigInt(a.launchTimestamp),
  });
}

export async function onLivePoolRegistered({ event, context }: { event: Event<"VeradaLiveHook:PoolRegistered">; context: Context<"VeradaLiveHook:PoolRegistered"> }) {
  await upsertToken(context.db, event.args.token, event, { quote: event.args.quote, poolId: event.args.poolId });
}

/** One swap fee: converted and credited (the vault's `Credited` follows), or held for its cause. */
export async function onFeeTaken({ event, context }: { event: Event<"VeradaLiveHook:FeeTaken">; context: Context<"VeradaLiveHook:FeeTaken"> }) {
  const a = event.args;
  await context.db.insert(liveFee).values({
    id: event.id,
    token: a.token,
    causeId: a.causeId,
    rotation: a.rotation,
    quote: a.quote,
    quoteAmount: a.quoteAmount,
    usdcOut: a.usdcOut,
    converted: a.converted,
    failure: a.failure,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  if (!a.converted) await bumpCause(context.db, a.token, a.causeId, { heldQuote: a.quoteAmount, at: event.block.timestamp });
}

export async function onHeldRetried({ event, context }: { event: Event<"VeradaLiveHook:HeldRetried">; context: Context<"VeradaLiveHook:HeldRetried"> }) {
  const a = event.args;
  await context.db.insert(liveHeldRetry).values({
    id: event.id,
    token: a.token,
    causeId: a.causeId,
    caller: a.caller,
    quoteIn: a.quoteIn,
    usdcOut: a.usdcOut,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpCause(context.db, a.token, a.causeId, { heldQuote: -a.quoteIn, at: event.block.timestamp });
}

// ---- LiveDonationVault

export async function onLiveTokenRegistered({ event, context }: { event: Event<"LiveDonationVault:LiveTokenRegistered">; context: Context<"LiveDonationVault:LiveTokenRegistered"> }) {
  const a = event.args;
  await upsertToken(context.db, a.token, event, {
    threshold: a.threshold,
    initialCause: a.initialCause,
    initialPeriod: Number(a.period),
    registeredAt: event.block.timestamp,
  });
}

/** USDC credited for a token: 10% platform, 90% to the cause active when the fee was earned. */
export async function onCredited({ event, context }: { event: Event<"LiveDonationVault:Credited">; context: Context<"LiveDonationVault:Credited"> }) {
  const a = event.args;
  await bumpCause(context.db, a.token, a.causeId, {
    gross: a.gross,
    platform: a.platform,
    causeShare: a.causeShare,
    at: event.block.timestamp,
  });
  await bumpVault(context.db, { accrued: a.platform });
}

export async function onLiveDonated({ event, context }: { event: Event<"LiveDonationVault:Donated">; context: Context<"LiveDonationVault:Donated"> }) {
  const a = event.args;
  await context.db.insert(liveDonation).values({
    id: event.id,
    token: a.token,
    causeId: a.causeId,
    org: a.org,
    amount: a.amount,
    orgDeployed: a.orgDeployed,
    inSwap: a.inSwap,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpCause(context.db, a.token, a.causeId, { donated: a.amount, at: event.block.timestamp });
}

/** A due push was not made; the credit stays pending. */
export async function onDonationDeferred({ event, context }: { event: Event<"LiveDonationVault:DonationDeferred">; context: Context<"LiveDonationVault:DonationDeferred"> }) {
  const a = event.args;
  await bumpCause(context.db, a.token, a.causeId, { deferReason: a.reason, at: event.block.timestamp });
}

export async function onPlatformWithdrawn({ event, context }: { event: Event<"LiveDonationVault:PlatformWithdrawn">; context: Context<"LiveDonationVault:PlatformWithdrawn"> }) {
  await bumpVault(context.db, { withdrawn: event.args.amount });
}

export async function onSkimmed({ context }: { event: Event<"LiveDonationVault:Skimmed">; context: Context<"LiveDonationVault:Skimmed"> }) {
  await bumpVault(context.db, { skim: true });
}

// ---- FeeConsolidator

/** `convertClaims`: the live hook's in-swap conversions and its retries of held fees. */
export async function onClaimsConverted({ event, context }: { event: Event<"FeeConsolidator:ClaimsConverted">; context: Context<"FeeConsolidator:ClaimsConverted"> }) {
  const a = event.args;
  await context.db.insert(claimsConversion).values({
    id: event.id,
    source: a.source,
    currency: a.currency,
    to: a.to,
    amountIn: a.amountIn,
    settlementOut: a.settlementOut,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
}
