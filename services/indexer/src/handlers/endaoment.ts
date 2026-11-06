import type { Context, Event } from "ponder:registry";
import { endaomentEntity, orgDonation } from "ponder:schema";
import { causeIdOfOrg } from "@varada/sdk";
import type { Hex } from "viem";
import { EndaomentEntityAbi, EndaomentFactoryAbi } from "../abis";

/** Endaoment OrgFundFactory (the same address on chains 1, 10 and 8453). */
export const ENDAOMENT_ORG_FUND_FACTORY = "0x10fD9348136dCea154F752fe0B6dB45Fc298A589" as const;

type Ctx = Context<"EndaomentOrg:EntityDonationReceived">;

const FACTORY = ENDAOMENT_ORG_FUND_FACTORY.toLowerCase();
const lower = (a: string) => a.toLowerCase() as Hex;

/**
 * The org id of `address` if it is a real Endaoment org: its `orgId()` must map back to the same
 * address through the OrgFundFactory's CREATE2 derivation. Funds (no `orgId()`) and look-alike
 * contracts get null. The answer is stored, so each emitter is checked once.
 */
async function orgIdOf(context: Ctx, address: Hex, at: bigint): Promise<Hex | null> {
  const known = await context.db.find(endaomentEntity, { address });
  if (known) return (known.orgId as Hex | null) ?? null;
  let orgId: Hex | null = null;
  try {
    const id = (await context.client.readContract({ abi: EndaomentEntityAbi, address, functionName: "orgId" })) as Hex;
    const expected = (await context.client.readContract({
      abi: EndaomentFactoryAbi,
      address: ENDAOMENT_ORG_FUND_FACTORY,
      functionName: "computeOrgAddress",
      args: [id],
    })) as Hex;
    if (lower(expected) === address) orgId = id;
  } catch {
    // Not an org (a fund, or not Endaoment at all).
  }
  await context.db
    .insert(endaomentEntity)
    .values({ address, orgId, causeId: orgId ? causeIdOfOrg(orgId) : null, checkedAt: at })
    .onConflictDoNothing();
  return orgId;
}

/**
 * `EntityDonationReceived` from any address. Kept only when the emitter is a real Endaoment org
 * receiving the donation itself (`to` = emitter). The donor is the event's `from`, except through
 * the OrgFundFactory (`deployOrgAndDonate`), where `from` is the factory and the donor is the
 * transaction sender.
 */
export async function onEntityDonationReceived({ event, context }: { event: Event<"EndaomentOrg:EntityDonationReceived">; context: Ctx }) {
  const org = lower(event.log.address);
  const { from, to, tokenIn, amountIn, amountReceived } = event.args;
  if (lower(to) !== org) return;
  const orgId = await orgIdOf(context, org, event.block.timestamp);
  if (!orgId) return;
  const via = lower(from);
  const donor = via === FACTORY ? lower(event.transaction.from) : via;
  await context.db
    .insert(orgDonation)
    .values({
      id: event.id,
      org,
      orgId,
      causeId: causeIdOfOrg(orgId),
      donor,
      via,
      tokenIn: lower(tokenIn),
      amountIn,
      amount: amountReceived,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
}
