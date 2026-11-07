# Uniswap v3 route hops

Status: prototype on branch `mvp/consolidator-v3`. Not deployed, not audited, not merged. Why: Ondo
stock liquidity may sit outside Uniswap v4 (a fork probe of mainnet found live Uniswap v3 pools for
AAPLon/USDC and SLVon/USDC at the 1% tier, and deep WBTC/USDC and WBTC/WETH pools). Until now a registry
route could only be a chain of hookless v4 pools.

Scope: the contracts (`QuoteRegistry`, `FeeConsolidator`, new `FeeConsolidatorV3` and `V3SwapExecutor`). The swap engine in
`packages/sdk/src/swap` (user trades) is unchanged and still v4-only; see "Not covered".

## What changed

A route hop is still a `PoolKey`. A Uniswap v3 pool is encoded as a key with `tickSpacing == 0`
(`src/libraries/V3RouteLib.sol`):

| field | v3 hop |
| --- | --- |
| `currency0`, `currency1` | the pool's two ERC-20s, sorted, never native ETH |
| `fee` | one of 100, 500, 3000, 10000 |
| `tickSpacing` | `0` (the marker; Uniswap v4 rejects zero, so no real v4 pool collides) |
| `hooks` | `address(0)` |

Consequences: the `PoolKey[]` ABI, `routeOf`, the registry storage layout, the route length limit (3) and
mixed routes (v4 then v3, v3 then v4) all work without a new type.

- `QuoteRegistry._setRoute`: a hop with the marker must be a well formed v3 hop (`InvalidV3Hop`). Chaining
  rules are unchanged (the current asset must be one of the hop's currencies; the WETH to native ETH
  special case stays v4 only, a v3 hop uses WETH directly).
- `FeeConsolidator`: `_hop` dispatches on the marker. The guard is the same code for both kinds:
  reference-tick deviation (`references` table, keyed by the key hash, seeded with `seedReferences`,
  moved by `_moveReference`, `syncReference` works for v3 keys), minimum output
  `max(spot, reference) * (1 - maxSlippageBps - hopFee)` (the in-swap bounds for inline conversions),
  full fill, fail closed. `_hop` was split into `_prepare` / `_swapV4` / `_hopV3` only because the extra
  branch hit "stack too deep" under `via_ir`; the v4 arithmetic is untouched. The base contract has two
  virtual functions (`_v3Spot`, `_v3Swap`) that revert `V3Unsupported`.
- `FeeConsolidatorV3 is FeeConsolidator`: implements those two functions and deploys a `V3SwapExecutor`
  in its constructor (one more constructor argument than the base: the v3 factory, so the base contract
  and every existing test and script are unchanged). This is the contract to deploy.
- `V3SwapExecutor`: the only contract that talks to v3 pools and the pool's swap callback. Stateless,
  ownerless, holds nothing between calls; only its consolidator may call `swap`. It exists because
  inlining the v3 swap and callback pushed the consolidator's runtime to 24,589 bytes, over the 24,576
  limit (EIP-170). Now `FeeConsolidatorV3` is 24,507 bytes: **69 bytes of margin**, so any further change
  to the consolidator needs another split or a lower optimizer setting. (The base `FeeConsolidator` is
  23,462 bytes.)

## How a v3 hop executes

Everything runs inside the same `poolManager.unlock` as v4 hops (weekly consolidation) or inside the live
hook's own unlock (`convertClaims`), so the accounting of the following hop and the final `take` is
unchanged:

1. `poolManager.take(tokenIn, this, amount)` turns the credit into tokens.
2. The consolidator transfers `amount` to the executor, which calls `pool.swap(consolidator, zeroForOne,
   +amount, MIN/MAX_SQRT_PRICE ± 1, "")` on `factory.getPool(c0, c1, fee)` (zero means `V3PoolMissing`).
3. In `uniswapV3SwapCallback` the executor pays exactly what the pool asks, never more than `amount`.
4. The spent amount must equal `amount` (`PartialFill` otherwise, same selector as the v4 error). The
   output goes straight to the consolidator, which measures it from the balance difference (not from
   the pool's report) and checks it against the minimum (`SlippageTooHigh`).
5. The output is paid back into the pool manager (`sync`, transfer, `settle`) so the next hop or the
   final `take` sees a credit.

Failure behaviour is the v4 behaviour: every revert is inside `execute` (caught in `_attempt` and
`flushThrough`, which emit `ConsolidationFailed` and keep the raw amount held for `retry`) or inside
`convertClaims` (caught by the live hook, which holds the claims). Tests: a bad price, a deviating pool,
a partial fill, a missing pool, a paused Ondo token and a double callback all leave the trader's swap
succeeding and the fee held (`test/live/LiveV3Route.t.sol`).

### Why a direct pool call and not SwapRouter02 / Universal Router

| | direct pool (chosen) | SwapRouter02 / Universal Router |
| --- | --- | --- |
| trust path | factory (immutable) and the pool | plus the router and its approvals |
| approvals | none (the callback pays) | a standing or per swap ERC-20 approval, or Permit2 |
| deadline | not needed, see below | `exactInputSingle` in SwapRouter02 has none; UR has one |
| slippage | our own `minOut` after the swap, same as v4 | router's `amountOutMinimum`, plus ours |
| extra audit | the swap callback (about 15 lines) | router versions and encodings |
| flexibility | one pool per hop | router could multi-hop a path in one call |

No deadline argument: a consolidation is never signed or queued, it runs inside the transaction that
triggers it, so `block.timestamp` is its deadline. (The same is true of the v4 path.)

## Audit surface

1. `V3SwapExecutor.uniswapV3SwapCallback`. Authenticated by transient storage written only around the
   pool call (pool, input token, maximum amount) and cleared before paying, so a second callback pays
   nothing; a call from any other address, or outside a swap the executor started, reverts. It pays from
   the executor's own balance, which is only what the consolidator sent for this swap. The executor is
   not `nonReentrant`, but only the consolidator can start a swap and the consolidator's entry points
   (`consolidate*`, `retry*`, `flushThrough`, `convertClaims`) are `nonReentrant`, plus `execute` (self
   only). Stray tokens sent to the executor are unreachable except as a callback payment of a swap.
2. The `take` then `settle` pair around a v3 hop (`_hopV3`). It sets the synced currency only for the
   output token and settles it at once, so no synced currency is left behind. `convertClaims`' contract
   ("no currency synced when called") still holds on return.
3. Pool discovery through the factory at execution time, and the shape check inside `_pool` (`poolOf` in the executor: a stale or
   hostile registry cannot make the consolidator call an arbitrary address, only a factory pool of a
   sorted pair and tier is called). The factory is immutable.
4. Route validation (`V3RouteLib`, `QuoteRegistry`), fuzzed. The consolidator re-checks the shape.
5. Price guard parity. Same minimum output and deviation bound as v4. The reference table is keyed by
   the key hash, so a v3 pool is seeded and drifts exactly like a v4 pool. Spot is `slot0` (an
   instantaneous price, like v4 `getSlot0`); there is no TWAP for route pools in either version, the
   reference tick is the defence.
6. Token behaviour: output is measured by balance (fee on transfer tokens still get the minimum check); a
   paused or non-compliant Ondo token fails inside the callback transfer and reverts the whole attempt.
7. No new owner power over funds: the owner can still only choose routes (which the registry shape check
   and the guards constrain) and seed references, exactly as for v4. No router or Permit2 approvals exist.

## Gas

Measured with `forge test` (mock pool is constant price, so it is an upper bound on the pool's own work
only for the extra cold-storage reads; the fork numbers use real pools).

| conversion | v4 hop | v3 hop |
| --- | --- | --- |
| `convertClaims`, one hop, mock pool | 83.4k | 256.9k |
| `convertClaims`, one hop, real AAPLon/USDC v3 1% pool (fork) | n/a | 298.8k |
| live swap with inline conversion, one hop (mock; whole swap) | 551.8k | 680.9k |
| weekly consolidation of AAPLon / SLVon to USDC, 1 hop (fork, incl. vault credit) | n/a | 505.9k / 497.1k |
| weekly consolidation WBTC to USDC, 1 hop (fork) | n/a | 441.1k |
| weekly consolidation WBTC to WETH to USDC, 2 v3 hops (fork) | n/a | 602.8k |
| mock-pool consolidation, token to quote (v4) to USDC (v3) | | 622.5k |

A v3 hop costs about 170k to 215k more than a v4 hop (the extra `take`, the transfer to the executor and
the executor call, the pool's own cold state, the callback transfer and the `sync` / transfer / `settle`
back). The live hook's inline conversion gets `INLINE_GAS_BUDGET` = 650,000: one v3 hop (about 260k to
300k) fits with room, two fit, three all-v3 hops would not. Limit inline routes to at most two v3 hops, or raise the budget (and `LIVE_GAS_REQUIRED`) in the
redeploy. Weekly consolidation has no budget issue.

Optimisation left out to keep the diff small: for a route whose first hop is v3 the input is settled into
the pool manager and taken straight back; skipping that saves two token transfers (about 60k to 80k for
an Ondo token). The executor indirection costs roughly 25k per hop and could be folded back if the size
limit is solved another way. Pure-v3 quote-side conversions could also skip the unlock altogether.

## What must be redeployed

Nothing is deployed on mainnet yet from this repository (`contracts/deployments` is empty at the time of
writing), so this is a deploy-time choice rather than a migration. If a stack is live:

| contract | change | redeploy? |
| --- | --- | --- |
| `FeeConsolidatorV3` | new contract (immutable registry, vault, pool manager) | yes, new |
| `QuoteRegistry` | shape check only; already stores v3-shaped keys unchecked | recommended; the consolidator holds the registry immutably, so a new registry means a new consolidator anyway |
| `FeeVault` | `setConsolidator` is once only | yes, if the old one has a consolidator set |
| `VaradaHook`, `VaradaLiveHook` | consolidator is an immutable (and the live hook also holds the registry) | yes (new mined addresses); also the factory that deploys them if it embeds the hook |
| `VaradaLpLocker` | consolidator is an immutable | yes |
| existing token pools | pools are bound to their hook | stay on the old stack with v4 routes only; no v3 for them |

An old `FeeConsolidator` that reads a registry route containing a v3 hop does not misbehave: the v4 pool
manager has no pool for that key, the hop reverts `PoolNotInitialized`, and the amount is held (fail
closed).

Migration path: (1) deploy registry, vault, `FeeConsolidatorV3`, hooks, locker, factory together on a
fresh stack; (2) set v3 routes only for assets whose route is better through v3 (`setRoute` with
`V3RouteLib.hop(asset, USDC, fee)` or a mixed list), then `seedReferences` at a fair price (seeding
reads the v3 pool and reverts `V3PoolMissing` if it does not exist); (3) new launches against those
assets use the new stack; (4) old stack keeps converting what it holds. Deploy script and SDK are not
changed on this branch (`script/Deploy.s.sol` still deploys the base consolidator).

## Not covered

- Swap engine (`packages/sdk/src/swap`): user trades still route over v4 only. Adding v3 pools there
  needs discovery through the factory, the v3 quoter, and Universal Router `V3_SWAP_EXACT_IN` commands.
- Uniswap v2. Cheap to add with the same shape (a marker such as `tickSpacing == -1`, `getReserves`
  for spot, transfer in then `swap` out, no callback), but a v2 pair has no concentrated liquidity so
  thin stock pairs are more manipulable; the reference-tick guard applies unchanged. Left out.
- Deadline parameters, multi-hop in a single router call, v3 TWAP oracle, an owner-set factory.
- Real-pool failure injection is limited to a price-push on the WBTC pool; pause and compliance failures
  are exercised with mocks.

## Tests

`test/consolidator/FeeConsolidatorV3.t.sol` (20, incl. fuzz), `QuoteRegistryV3.t.sol` (8, incl. fuzz),
`test/live/LiveV3Route.t.sol` (8: inline conversion, never reverts, retry, gas),
`test/fork/ConsolidatorV3Fork.t.sol` (6, real pools, needs `ETH_RPC_URL`):

```
ETH_RPC_URL=<mainnet rpc> forge test --match-contract 'V3' -vv
```
