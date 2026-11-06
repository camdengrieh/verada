---
title: "Chapter 5: Quote assets, pricing and routing"
description: Decision record, flows, pricing module, Ondo reference feeds, liquidity findings, runbook and accepted risks for quote assets, USD pricing and fee routing.
---

# Chapter 5: Quote assets, pricing and routing

> **Delivery status, read first.** This chapter is written against `origin/main` at `d6266cc`. Four
> pieces of it are delivered on parallel branches that had **no commits** when this was written:
> `mvp/consolidator-v3` (v3 hops in `QuoteRegistry` and `FeeConsolidator`), `mvp/swap-v3-v2` (v3 and v2
> in the swap engine), `mvp/usd-pricing` (the pricing module with the Ondo reference) and
> `mvp/rwa-depth-order` (RWAs ordered by depth). Those parts are marked **Design**: they state what was
> decided, not what the code does. Statements marked **On main** were checked against the code at that
> commit. Re-check every **Design** part against the merged code before relying on it.

> **No third-party audit.** The product ships without an independent audit, because of time. That includes
> the v3 consolidator change. What was and was not reviewed is in
> [SECURITY.md](../SECURITY.md#review-status); the accepted risks are in
> [section 10](#10-known-limits-and-accepted-risks).

## 1. What this chapter delivers

Fees accrue in whatever a token is paired against and end up as USDC for the cause.

- A token's pool is the token against a **quote asset**: WETH or an Ondo RWA today, and more by registry
  configuration.
- The quote asset's fees **consolidate to USDC** along a route stored in the `QuoteRegistry`.
- The app shows **USD prices**, and lists RWAs **ordered by depth**.
- The swap engine reaches liquidity on Uniswap **v3 and v2**, and routes may contain **v3 hops**.

## 2. Decision record

### D1. More pairs by registry configuration, not by contract change

- **Decision.** A new pair is `QuoteRegistry.addQuoteAssetWithRoute(asset, kind, route)` (an owner call),
  not a new contract or a new `FeeConsolidator`.
- **Why.** The consolidator holds fee balances and has no upgrade path. Every change to it is risk that, with
  no external audit, nobody outside the team reviews. The registry already holds the only per-asset facts:
  decimals, kind, active flag and the route. `_setRoute` checks that every hop connects and the last ends in
  the settlement asset, with at most `MAX_ROUTE_LENGTH = 3` hops (**On main**).
- **What it costs.** Adding an asset is an owner transaction, so the owner (a multisig after hand-over, see
  [DEPLOYMENT.md](../DEPLOYMENT.md)) decides what is listed. Deactivating an asset blocks new launches only;
  its route is kept so existing pools keep converting (**On main**).
- **Gate.** `FeeConsolidator.registerPool` accepts a pool only if `isAllowed(quote)` and the quote has a
  route (**On main**).

### D2. USD from on-chain pools, with the Ondo reference price as a second source

- **Decision.** The USD price of an asset is the mid price of a route of on-chain pools to USDC. For Ondo
  RWAs it is cross-checked against Ondo's reference price.
- **Why.** On main, USD prices are pool mid prices only, with no oracle (`apps/web/src/lib/swap/usd.ts`,
  [SWAP.md](../SWAP.md#limits)). A thin RWA pool (the AMZNon / USDC pool held about $10k) can be moved by
  one trade, so a pool price alone can be wrong. A second independent source turns "the price looks odd"
  into a visible disagreement.
- **Why not oracle only.** The reference is a share price. It is stale outside market hours and when Ondo
  pauses a token. The pool is the price a trader can actually execute at.
- **Where it applies.** Display and warnings in the app. The consolidator's own guards stay pool-based
  (reference ticks and TWAP, [section 6](#6-live-and-weekly-consolidation)); it does not read the Ondo feed on
  main. **Design:** confirm against the merged `mvp/usd-pricing`.

### D3. RWAs ordered by depth

- **Decision.** In pickers and lists, RWAs are sorted by how much can be sold into USDC at low price
  impact, deepest first.
- **Why.** Pairing a token with a quote asset whose route cannot absorb its fees means the conversion fails
  the slippage guard and the fees stay held (D5, section 8). The app already measures this:
  `loadQuoteRouteDepth` returns the price impact of selling $10,000 of the quote asset to USDC along the best
  route, or `null` when no route can fill it (**On main**, `apps/web/src/lib/swap/depth.ts`). Ordering by it
  puts the quote assets that will convert at the top.
- **Design.** The ordering itself is `mvp/rwa-depth-order`.

### D4. Uniswap v3 and v2 in the swap engine

- **Decision.** The swap engine searches v3 and v2 pools in addition to hookless v4 pools.
- **Why.** On main the engine routes through hookless v4 pools only, so an asset whose only liquidity is on
  v3 has no route and no USD price ([SWAP.md](../SWAP.md#limits)).
- **What it changes.** More routes and prices are found. Router calldata gains the v3 and v2 swap commands
  (`V3_SWAP_EXACT_IN`; the v2 equivalent) and the engine needs the v3 quoter. The Ondo and Permit2 checks
  must apply to the new hops as they do to v4 ones. **Design**, `mvp/swap-v3-v2`.

### D5. V3 hops in registry routes and the FeeConsolidator

- **Decision.** A registry route may contain a Uniswap v3 hop, so a quote asset whose only deep pool is on
  v3 can still consolidate to USDC.
- **Why.** Without it, D4 would let users trade an asset that the consolidator then cannot convert, and its
  fees would stay held. On main a route is a `PoolKey[]` of v4 pools, and `FeeConsolidator._hop` swaps through
  the pool manager inside one unlock (**On main**).
- **What it changes.** See [section 6](#6-live-and-weekly-consolidation). In short: a v3 swap leaves the
  pool manager's unlock, so the live path (inside the trader's swap) and the weekly path differ in what they
  can safely do.
- **Risk.** This is the one change to fee-holding code made without an external audit
  ([section 10](#10-known-limits-and-accepted-risks)).

## 3. Architecture

```
                          owner (multisig)
                               |  addQuoteAssetWithRoute / setRoute / seedReferences
                               v
 trader --swap--> v4 pool: token / QUOTE (WETH or Ondo RWA)   registerPool needs isAllowed(QUOTE) + a route
                    |  hook takes fees in token or QUOTE
                    v
   +-----------------------------+   routeOf(QUOTE), <=3 hops   +-----------------+
   | VaradaHook / VaradaLiveHook | ---------------------------> |  QuoteRegistry  |
   +-----------------------------+                              +-----------------+
        |                |                                              ^ routeOf
        | weekly         | live (inside the swap)                       |
        v                v                                              |
   FeeConsolidator <-- convertClaims(inSwap = true) ---------- FeeConsolidator
        |  consolidate / consolidateAccrued / retry / flushThrough
        |  hop 1 .. hop N, price guards on each   (Design: hop kinds v4 and v3)
        v
      USDC
        |-- weekly: FeeVault epoch pool -> settle -> DonationDistributor
        '-- live:   LiveDonationVault.creditLive(token, cause, rotation) -> Endaoment org
```

```
 App (read only, public client)
   discoverPools (v4; Design: v3, v2) -> enumerateRoutes -> pickBestQuote (V4Quoter; Design: v3 quoter)
   loadUsdPrices       : stables = $1; others = mid price of the shortest route to USDC
                         Design: cross-check Ondo RWAs against the Ondo reference
   loadQuoteRouteDepth : impact of selling $10k of the quote asset to USDC (Design: drives RWA order)
```

## 4. The pricing module

**On main.** `loadUsdPrices` (`apps/web/src/lib/swap/usd.ts`) sets USDC, USDT and DAI to $1, prices ETH and
WETH once, and prices every other asset as the mid price of the first route to USDC from `enumerateRoutes`
(up to 3 hops). Mid price means no fees and no slippage. An asset with no route has no price.

**Design (`mvp/usd-pricing`).** For each asset the module should return a price and where it came from:

| Case | Result |
| --- | --- |
| Pool route, no Ondo feed | Pool price, source `pool`. |
| Pool route and Ondo reference agree within tolerance | Pool price, source `pool+ondo`. |
| They disagree beyond tolerance | Pool price shown as disputed; the trade panel warns. |
| Reference stale (section 5) or token paused | Pool price, with the reference marked unavailable. |
| No pool route, reference exists | Reference shown as indicative, not executable. |
| Neither | No price. |

The tolerance and the exact fallback order are whatever the merged module defines; this chapter does not fix
them.

## 5. The Ondo reference feed

The delivery brief names nine tokens with a reference price, plus the oracle that serves synthetic shares:

| Token | Kind (SDK) | Address (SDK) |
| --- | --- | --- |
| TSLAon | Stock | `0xf6b1117ec07684D3958caD8BEb1b302bfD21103f` |
| STRCon | Stock | `0xECABE1Ff8a9e1dC55899cf58dac8497ecE5Ae84c` |
| SPYon | ETF | `0xFeDC5f4a6c38211c1338aa411018DFAf26612c08` |
| QQQon | ETF | `0x0e397938C1Aa0680954093495B70A9F5e2249aBa` |
| IAUon | ETF | `0x4f0CA3df1c2e6b943cf82E649d576ffe7B2fABCF` |
| FLHYon | ETF | `0x54C1Ff361b402f66c13107421E6A431C3375EF24` |
| BILon | ETF | `0x2710E30d84B376c34a3B3036aa196b26a83A321b` |
| SGOVon | ETF | `0x8De5D49725550f7b318b2FA0f1B1F118E98E8D0F` |
| USFRon | ETF | `0xFb82561A955bF59B9263301126AF490D3799e231` |

`SyntheticSharesOracle`: `0x9BC39DB6fbB44B91a48b8D5A6C208B82B1741bE6`.

The token addresses and kinds are checked against `packages/sdk/src/ondo.ts`. That the nine tokens have a
feed, and the oracle address, come from the brief: they are not in the repository at `d6266cc`, and this
chapter's author did not read the oracle on chain. Verify each row against the oracle before showing the table
to users.

Caveats an operator and a reader must know:

- **`sValue`.** An Ondo token is a claim on a number of underlying shares that changes over time (corporate
  actions, accruing yield). The reference price is per share. One token's USD value is the reference price
  times the token's share multiplier (`sValue`). Using the share price as the token price is wrong by exactly
  that factor. The module must apply `sValue`; check it in the merged code and test it per token.
- **25 hour staleness rule.** A reference older than 25 hours is not used. The window covers one trading-day
  gap plus slack, so weekends and market holidays make references stale (the app's New York calendar already
  warns `market-closed`, `apps/web/src/lib/swap/calendar.ts`). On those days only the pool price is shown.
- **Pauses.** Ondo can pause one token or all tokens (`tokenPauseManager().isTokenPaused`,
  `allTokensPaused`, [SWAP.md](../SWAP.md#ondo)). While paused, `transfer` reverts, so a consolidator hop
  through that token fails and the fee stays held. The reference may keep updating while the token cannot
  move: a fresh reference does not mean "tradable".
- **Tokens with no feed.** The SDK lists 458 Ondo tokens; only the nine above are said to have a reference.
  Every other Ondo quote asset, including any added to the registry later, gets the pool price with no
  cross-check.
- **Reference is not execution.** It is a share price. The pool decides what a trade or a fee conversion
  actually receives.

## 6. Live and weekly consolidation

Both modes end in USDC for the cause. They differ in when the conversion runs and what a failure does.

### 6.1 Live mode: inline, in the trader's swap

**On main.** `VaradaLiveHook` takes the fee as claims in `afterSwap` and converts inside the same swap.
`_executeConversion` calls `FeeConsolidator.convertClaims(currency, amount, vault, inSwap = true)`. The
consolidator burns the claims, runs every route hop in the already-unlocked pool manager, and `take`s the USDC
to the `LiveDonationVault`; the hook then calls `creditLive(token, causeId, rotation, out)`.

- `convertClaims` needs the pool manager unlocked (`PoolManagerLocked` otherwise), a registered source
  (`isSource`) and a non-empty registry route (`NoRoute`).
- In a swap, a route hop with a hook is refused (`HookedRouteHop`), and the tighter in-swap guards apply:
  `inSwapMaxDeviationTicks` (default 300 ticks, about 3%) and `inSwapMaxSlippageBps` (default 100).
- A failed conversion never reverts the trader: the raw amount is held and `FeeTaken(..., converted = false,
  reason)` is emitted. `VaradaLiveHook.retryHeld` converts it later (permissionless, outside any pool
  manager flow). The swap needs about 0.77M gas left at `afterSwap` ([SWAP.md](../SWAP.md)).

**How v3 hops affect it (Design, `mvp/consolidator-v3`).** A v3 swap cannot run as just another hop inside the
pool manager's unlock. The consolidator would have to take the input out of the pool manager, call the v3
pool (whose callback pulls the input), and settle the output back, all while the trader's swap is open and the
hook's gas budget is capped. Things to check in the merged code:

- Each v3 hop adds gas inside the trader's swap, so the required-gas check and the numbers in
  `contracts/test/live/LiveGas.t.sol` must be re-measured. A budget miss holds the fee; it does not lose it.
- The in-swap price guards must apply to a v3 hop as they do to v4 hops. If they cannot, the safe design is
  to refuse v3 hops in swap (as hooked hops are refused today) and hold the fee for `retryHeld`.

### 6.2 Weekly mode: collect, then consolidate

**On main.** Fees reach the consolidator in two ways: the hook calls `consolidate(token, currency, amount)` as
fees are taken, and `VaradaLpLocker.collectFees(token)` (permissionless) takes the LP fees, measures them by
balance delta and calls `consolidateAccrued(token, currency, amount, since)`, which attributes them to the
epochs of that interval.

The consolidator swaps the held balance along the route in one `unlockCallback`. On any revert (paused Ondo
token, no liquidity, a price guard) the raw amount stays held, `ConsolidationFailed` is emitted, and anyone can
call `retry(token, currency)`, or `retryAmount` for a balance too large for the pool. `FeeVault.settle(token,
epoch)` first brings the epoch's fees in: it calls `collectFees` if the last collection is older than the epoch
end, then `FeeConsolidator.flushThrough(token, epoch)`. If something earned in that epoch is still outside the
vault, `settle` reverts `FeesPending` until `SETTLE_GRACE` (7 days) after the epoch end, then pays what is
there. The USDC goes to the `DonationDistributor` once per epoch.

**How v3 hops affect it (Design).** Weekly conversion is not inside a trader's swap, so it is the safer place
for a v3 hop: it has its own gas and uses the normal (not in-swap) guards. Held-fee retry covers a v3 failure
as it covers a v4 one. To verify: `flushThrough` swaps the whole held balance, oldest epoch tag first, and
splits the output across tags; confirm the split is still exact when a hop leaves the pool manager.

## 7. Registry route configuration

**On main.** A route is an ordered `PoolKey[]`. Starting from the quote asset, each hop swaps the current
currency for the pool's other currency; the last hop must end in USDC (`RouteDoesNotSettle`); a disconnected
hop reverts (`RouteDisconnected`); WETH may feed a native-ETH pool, which the consolidator unwraps. After
setting a route the owner must seed the price reference of each route pool (`seedReferences`, only while the
pool trades at a fair price). Until then every hop reverts and the fee stays held
([SECURITY.md](../SECURITY.md#operational-requirements)).

**Design.** A v3 hop needs a representation in the route (a pool address and fee rather than a `PoolKey`), a
connectivity check in `_setRoute`, and a reference for its price guard. This chapter does not fix that shape;
read `mvp/consolidator-v3` once it has commits.

## 8. Liquidity findings

The liquidity survey (depth of each candidate quote asset against USDC and WETH on v4, v3 and v2) is
**pending**: no survey result was in the repository when this chapter was written. What is established:

- **Measured, on main.** The real AMZNon / USDC v4 pool held roughly $10k at fork block 26,356,950. One ETH
  routed through it showed a 99.95% price impact and was blocked (`price-impact`, threshold 30%)
  ([SWAP.md](../SWAP.md#limits)). Thin RWA pools run out of liquidity inside their tick range.
- **Consequence.** An RWA is a good quote asset only if its route to USDC is deep enough for the fees it will
  generate. A pairing with a thin route does not lose the fees; it holds them until a retry succeeds.
- **To fill in after the survey.** A table of candidate quote assets with depth at $1k, $10k and $100k impact
  on each venue, and the registry route each gets.

## 9. Operational runbook

1. **List an asset.** Check it has a deep route to USDC (section 8), is not paused, and does not shrink
   balances (no negative rebasing). Then `addQuoteAssetWithRoute`, then `seedReferences` for every route pool,
   then confirm `isAllowed` and `hasRoute`.
2. **Unlist an asset.** `deactivateQuoteAsset`. Existing pools keep converting.
3. **Held fees.** Watch `ConsolidationFailed` (weekly) and `FeeTaken` with `converted = false` (live). Call
   `retry` or `retryAmount` (weekly) or `retryHeld` (live); anyone can. If a reference fell behind a moved
   market, call `syncReference(key)`. If a legitimate large move (for example an Ondo reopening gap) exceeds
   the drift band, the owner re-anchors with `seedReferences` or `setReference`.
4. **Ondo pause.** Fees in a paused token stay held. Do not route around a pause. Retry after it lifts.
5. **Stale reference.** Treat a pool price with no fresh Ondo reference as unverified, especially outside New
   York market hours.
6. **Tuning.** `setMaxSlippageBps` (ceiling 2000), `setMaxDeviationTicks`, `setMaxDriftTicks`,
   `setInSwapBounds`. Owner calls; keep them tight.
7. **Ownership.** Hand ownership to a multisig and accept every two-step transfer
   ([DEPLOYMENT.md](../DEPLOYMENT.md)).
8. **Before enabling a v3 route.** Re-measure live-mode gas, run the consolidator fork suite, and seed
   references. Do not enable it for live-mode tokens unless the in-swap guard is shown to apply
   (section 6.1).

## 10. Known limits and accepted risks

- **No third-party audit.** Not for the protocol and **not for the v3 consolidator change**. That change is
  covered only by the team's automated adversarial review, Foundry tests (unit, fuzz, invariant) and fork
  tests. [SECURITY.md](../SECURITY.md#review-status) says exactly what that is and is not.
- **The consolidator holds fees.** What bounds a loss: hard ceilings on slippage
  (`MAX_SLIPPAGE_CEILING_BPS = 2000`) and hop fee (`MAX_HOP_FEE_BPS = 1000`), price guards that fail closed,
  and that it holds fees, not principal. None of these bounds a logic bug in a new v3 hop.
- **Owner trust.** The owner chooses listed assets and routes and seeds references. A wrong route, or a
  reference seeded at a manipulated price, can convert at a bad price inside the guards. A multisig and
  two-step ownership reduce this; they do not remove it.
- **Thin RWA pools.** Fees can stay held for a long time. Weekly `settle` waits up to `SETTLE_GRACE` (7 days)
  and then pays what it has.
- **Ondo token risk.** Pauses, blocklists and compliance checks are Ondo's. A paused or blocked path holds
  fees. Tokens with no feed have no second price source.
- **Second-source prices are indicative.** The reference is a share price, may be more than 25 hours old, and
  is not executable. A disagreement is a warning, not proof of manipulation.
- **Pool prices are manipulable in thin pools.** The app's USD display uses a single pool's mid price, not a
  TWAP. The consolidator uses references and TWAP for fees.
- **Live mode gas.** More hops cost gas inside the trader's swap; a swap with too little gas holds the fee
  instead of converting it.
- **Dependencies are trusted.** Uniswap v4, v3 and v2, the Universal Router, Ondo contracts and the oracle.
- **This chapter's own gaps.** The Design parts, the Ondo feed list and the liquidity survey are unverified or
  pending as marked. Tests were not re-run for this chapter.
