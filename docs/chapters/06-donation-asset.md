# 06. Donation asset: USDC or ETH

Status: contracts implemented on `mvp/donation-asset-contracts`. Mainnet fork evidence: see the
"Verification" section.

## Decision record

**Question.** Fees used to consolidate into USDC for every token. Some quote assets have better
pools into ETH than into USDC (a WETH-quoted token needs no conversion at all into ETH; most Ondo
stock tokens only have USDC pools). Each token now chooses its *donation asset* at launch: `Usdc`
(default, unchanged behaviour) or `Eth`.

**Endaoment takes USDC.** Its `donate` entry pulls the org's base token (USDC). ETH goes in through
a swap wrapper (`swapAndDonate` / `deployOrgSwapAndDonate`) that swaps on an Endaoment-approved
Uniswap v3 path with calldata we would have to build, with a minimum output we would have to derive
from some price source. Two options were weighed:

| | A. Hold WETH, convert at push time through our own route | B. Donate ETH through Endaoment's swap wrapper |
|---|---|---|
| New trust | none: the same registry routes, reference ticks and slippage guards that already convert fees | Endaoment's wrapper registry, its v3 path, our own min-out source |
| Endaoment surface | unchanged (`donate`, `deployOrgAndDonate`, USDC only) | a second entry point per org state (deployed or not), wrapper allowlist can change |
| Failure mode | conversion reverts, pool stays pending, anyone retries | swap reverts inside Endaoment; we cannot tell price fail from wrapper change |
| Gas | one extra v4 swap at push | one v3 swap inside the wrapper, comparable |

**Chosen: A.** Vaults hold WETH (an ordinary ERC20, no ETH transfers or reentrancy through
receive hooks). When a pool is pushed to Endaoment the WETH is converted to USDC through the
registry's WETH to USDC route with the consolidator's price guards, then donated exactly as before.
The Endaoment calls stay byte-identical for both assets, and the conversion is aggregated per
epoch or per threshold push (one swap for a whole pool) instead of per fee.

## Interface

* `enum DonationAsset { Usdc, Eth }` (`src/interfaces/IDonationAsset.sol`), default `Usdc` = 0.
* `VaradaFactory.DeployParams.donationAsset` (last field). Stored in `donationAssetOf(token)`.
  A launch reverts with `DonationRouteMissing(quote, asset)` when the quote has no route into the
  chosen asset, or, for `Eth`, when WETH has no route into USDC (needed for the push).
* `QuoteRegistry`: `routeOf(asset)` is still the USDC route. New: `setRouteTo(asset, da, route)`,
  `routeToOf`, `hasRouteTo`, `donationToken(da)`. An `Eth` route must end in WETH (or in native ETH,
  which the consolidator wraps). WETH itself has an implicit empty `Eth` route
  (`hasRouteTo(weth, Eth) == true`, `setRouteTo(weth, Eth, ..)` reverts `RouteIsImplicit`).
* `FeeVault.registerToken(token, da)` / `donationAssetOf(token)` / `weth()`; separate USDC and WETH
  ledgers (`totalTracked` and `totalTrackedEth`, `platformAccrued()` and `platformAccruedEth()`).
  `withdrawPlatform()` pays every asset with a balance.
* `FeeConsolidator`: fees go to the token's target (`vault.donationAssetOf`). Quote equal to
  target (WETH and `Eth`) skips the unlock entirely. New `convertClaimsTo(.., da)` (live hook),
  `convertDonation(amount, to)` (WETH to USDC, for the vaults; callers must be `isSource`).
* `DonationDistributor`: `receiveFunds`/`distribute` know the asset per token (read from the vault),
  `reservedEth`, converts before donating. `Donated(.., amount, asset, usdcAmount)`.
* `LiveDonationVault`: `registerToken(.., asset)`, per-asset `Totals`, `pendingOf` in donation-asset
  units, threshold in donation-asset units (USDC: up to 1,000,000; ETH: up to 1,000 WETH).
  Events: `LiveTokenRegistered`, `Credited`, `Donated` carry `asset`; `Donated` also `usdcAmount`.
* `VaradaLiveHook.FeeTaken(.., asset)`; `usdcOut` is in donation-asset units.
* `FeesCollected` and `Settled` already carried the currency address (USDC or WETH).

## Flows

Weekly: swap fee in quote or token -> `FeeConsolidator` swaps along `routeToOf(quote, asset)`
(token side prepends the token pool) -> `FeeVault.depositFees` (units of the asset, 10/90 split) ->
`settle` sends the asset to the distributor -> `distribute`: USDC donates as before; WETH goes
`consolidator.convertDonation` -> USDC -> `donate` / `deployOrgAndDonate`.

Live: fee claims -> `convertClaimsTo(.., asset)` inline (inSwap bounds) -> vault in the asset ->
`creditLive`. Threshold reached: in-swap push attempt (USDC: 220k gas; ETH: 600k gas because it also
converts) else deferred; `flush` pushes any time, converting WETH first.

## Gas and limits

* USDC tokens: no extra cost except one storage read of the asset per credit and per fee.
* WETH-quoted ETH tokens save the whole quote-side swap.
* ETH push needs a WETH to USDC swap (about one v4 swap). The in-swap push envelope of the live hook
  (650k inline budget) usually cannot afford it, so ETH tokens normally defer to the permissionless
  `flush`. A keeper or any donor can call it; nothing is lost while pending.
* The WETH to USDC leg uses the registry route of WETH with the in-swap bounds inside a swap and the
  normal bounds otherwise. A failed guard reverts the push; the pool stays pending and is retried.
* Existing deployments: `DeployParams` gains a field (ABI change), vaults and consolidator gain
  functions; old tokens are `Usdc` implicitly.
* The distributor and the live vault must be registered as consolidator sources
  (`setSource`); deploy scripts do this.

## Verification

Unit, fuzz and live-hook tests on a real PoolManager: `test/consolidator/DonationAssetConsolidator.t.sol`,
`test/live/LiveDonationAsset.t.sol`, distributor tests in `test/DonationDistributor.t.sol`, and the
mainnet-fork suite `test/fork/DonationAssetFork.t.sol` (WETH-quoted token, USDC-pool-only Ondo token
routed to ETH over two hops, live and weekly, held-fee retry, threshold push in ETH and USDC).
