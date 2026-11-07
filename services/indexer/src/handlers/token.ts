import type { Context, Event } from "ponder:registry";
import { token, tokenFocus, tokenMarket, tokenProfile } from "ponder:schema";
import { DONATION_ASSET_ENUM, donationAssetOrDefault, donationAssetReadAbi, parseDonationAsset } from "@varada/sdk";
import { VaradaFactoryAbi, VaradaTokenAbi } from "../abis";

/** Reads `name()` or `symbol()` at the launch block; empty on any failure. */
async function readString(
  context: Context<"Factory:TokenCreated">,
  address: `0x${string}`,
  functionName: "name" | "symbol",
): Promise<string> {
  try {
    const v = await context.client.readContract({ abi: VaradaTokenAbi, address, functionName });
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/**
 * The token's donation asset (0 USDC, 1 ETH): from the event when it carries one, else the
 * factory's `donationAssetOf` at the launch block; USDC when neither answers (a pre-choice factory).
 */
async function readDonationAsset(context: Context<"Factory:TokenCreated">, a: { token: `0x${string}` } & Record<string, unknown>): Promise<number> {
  const fromEvent = parseDonationAsset(a.donationAsset);
  if (fromEvent !== null) return DONATION_ASSET_ENUM[fromEvent];
  try {
    const v = await context.client.readContract({
      abi: donationAssetReadAbi,
      address: context.contracts.Factory.address as `0x${string}`,
      functionName: "donationAssetOf",
      args: [a.token],
    });
    return DONATION_ASSET_ENUM[donationAssetOrDefault(v)];
  } catch {
    return 0;
  }
}

export async function onTokenCreated({
  event,
  context,
}: {
  event: Event<"Factory:TokenCreated">;
  context: Context<"Factory:TokenCreated">;
}) {
  const a = event.args;
  if (await context.db.find(token, { address: a.token })) return;
  const [name, symbol] = await Promise.all([
    readString(context, a.token, "name"),
    readString(context, a.token, "symbol"),
  ]);
  // The registry registers the token earlier in the same transaction.
  const donationAsset = await readDonationAsset(context, a);
  const p = await context.db.find(tokenProfile, { token: a.token });
  const f = await context.db.find(tokenFocus, { token: a.token });
  await context.db
    .insert(token)
    .values({
      address: a.token,
      creator: a.creator,
      pool: a.pool,
      hook: a.hook,
      lpTokenId: a.lpTokenId,
      feeBps: a.feeBps,
      metadataUri: a.metadataURI,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      txHash: event.transaction.hash,
      donationAsset,
      name,
      symbol,
      label: p?.label ?? null,
      labelhash: p?.labelhash ?? null,
      controller: p?.controller ?? null,
      editor: p?.editor ?? null,
      logoRef: p?.logoRef ?? null,
      suppressed: p?.suppressed ?? false,
      registeredAt: p?.registeredAt ?? null,
      categoryMask: f?.categoryMask ?? null,
      regionMask: f?.regionMask ?? null,
    })
    .onConflictDoNothing();
  // The quote asset is known from launch, so Discover can filter by pair before the first trade.
  // The first trade resolves it again (and keeps this row) if the read fails here.
  try {
    const quote = (await context.client.readContract({
      abi: VaradaFactoryAbi,
      address: context.contracts.Factory.address as `0x${string}`,
      functionName: "quoteAssetOf",
      args: [a.token],
    })) as `0x${string}`;
    if (quote.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      await context.db
        .insert(tokenMarket)
        .values({ token: a.token, pool: a.pool, quote, tokenIsCurrency0: a.token.toLowerCase() < quote.toLowerCase() })
        .onConflictDoNothing();
    }
  } catch {
    // resolved on the first trade
  }
}
