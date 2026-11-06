# Swap engine

How a user buys and sells a Varada token: pool keys, routing over existing Uniswap v4 pools,
quotes, fees, Universal Router calldata, Permit2, Ondo checks, and what is not covered.

Code: `packages/sdk/src/swap` (no React, no network assumptions beyond a viem-style client),
`apps/web/src/lib/swap` (app glue), `apps/web/src/hooks/use-swap*.ts(x)` (hooks) and
`apps/web/src/components/swap` (`ConnectedTradePanel`).

## Pools

Every Varada token has one pool: the token against its quote asset (WETH or an Ondo token), dynamic
fee flag `0x800000`, tick spacing 200 (`VaradaFactory.TICK_SPACING`), `hooks` = the token's hook
(`VaradaHook`, or `VaradaLiveHook` for live-donation tokens; the indexer's `token.hook`).
`varadaPoolKey(token, quote, hook)` sorts the currencies and `poolIdOf(key)` is
`keccak256(abi.encode(key))`. State comes from `StateView` (`getSlot0`, `getLiquidity`), batched with
multicall.

## Fees

Both hooks answer `currentFeeBps(token)` (base fee plus a surcharge that falls linearly to zero over
`sniperDecaySeconds`, rounded up) and `feeConfig(token)`. `readVaradaFee` returns `feeBps`,
`baseFeeBps`, `sniperBps`, `sniperActive`, `sniperEndsAt` and the 90 / 10 split
(`causeShareBps` 9000, `platformShareBps` 1000).

- `VaradaHook` (weekly): the base fee is the pool's LP fee on the input (accrues to the locked
  position); the surcharge is taken by the hook from the swap's output through a return delta and
  sent to the fee consolidator.
- `VaradaLiveHook`: the LP fee is zero; the whole fee is taken in the quote asset and converted to
  USDC for the active cause inside the swap. The swap needs about 0.77M gas left at `afterSwap`
  (`LIVE_GAS_REQUIRED`); `useSwap` simulates with `eth_estimateGas` and sends 1.25 times the estimate.

The V4Quoter runs the real swap including the hook, so quotes already contain the LP fee and the
surcharge. Verified on a mainnet fork: quoted output equals executed output to the wei for the weekly
hook, the live hook and an Ondo-quoted token. The surcharge depends on `block.timestamp`; a quote
made in one block can differ from the execution in a later block while the surcharge is decaying,
which the slippage limit absorbs.

`priceImpactPct` is the execution price against the pools' mid price (from `slot0`) after removing
the fees along the route, never negative.

## Routing

A token trades against its quote asset only, so paying in another asset needs a route. Route finding
has three steps (`routing.ts`, `quote.ts`; `quoteTrade` in `engine.ts` runs them):

1. `discoverPools`: the candidate pools are every hook-less pair among {user asset, quote asset, hubs}
   in the fee tiers `DEFAULT_FEE_TIERS` (100/1, 500/10, 3000/60, 10000/200 and 10000/100, which the
   Ondo pools use), plus the token's own pool. One `StateView` multicall tells which exist
   (initialized, liquidity > 0). Cached for 10 s.
2. `enumerateRoutes`: all simple paths of at most three pool hops. Native ETH (address zero, the v4
   currency) and WETH are different nodes joined by a free wrap / unwrap edge. Per pair the two
   deepest pools are kept. Shortest first, at most 10 candidates.
3. `pickBestQuote`: every candidate is quoted through the V4Quoter, four at a time (`quoteExactInputSingle`
   or `quoteExactInput`, exact-out forms for exact-out); highest output (exact-in) or lowest input
   (exact-out) wins. A route with a wrap in the middle is quoted segment by segment.

Hubs: ETH, WETH, USDC, USDT, DAI, WBTC (`DEFAULT_HUBS`); `extraHubs` adds nodes, for instance
allowlisted Ondo tokens that should be allowed as intermediate hops.

## Execution

`buildSwapCalldata` encodes `UniversalRouter.execute(commands, inputs, deadline)`:

- each v4 segment is one `V4_SWAP` with `SWAP_EXACT_IN_SINGLE` / `SWAP_EXACT_IN` (or the exact-out
  forms), `SETTLE_ALL` and `TAKE_ALL`; the minimum out is the `TAKE_ALL` minimum, the maximum in is the
  `SETTLE_ALL` maximum;
- ETH to WETH is `WRAP_ETH`, WETH to ETH is `UNWRAP_WETH` (with the minimum), value that stays in the
  router between commands is credited with `SETTLE(currency, CONTRACT_BALANCE, payerIsUser = false)`
  and taken with `TAKE(.., ADDRESS_THIS, OPEN_DELTA)`;
- native ETH input travels as `msg.value`.

Permit2 (`permit2.ts`): the token's ERC-20 allowance to Permit2 is raised once to the maximum (USDT
style tokens are reset to zero first); Permit2's allowance to the router is granted per swap with a
signed `PermitSingle` for exactly the amount and 30 minutes, consumed by a `PERMIT2_PERMIT` command in
the same transaction. A standing allowance that covers the amount is reused.

Slippage: exact-in sends `amountOutMin = amountOut * (1 - slippage)`; exact-out sends
`amountInMax = amountIn * (1 + slippage)` rounded up. The deadline is 20 minutes after building.

`useSwap` runs the state machine (approve, permit, gas simulation, swap, receipt) and surfaces
progress in `ConnectedTradePanel` and in a `txToast`. The gas simulation turns a revert into a typed
`SwapError` before the wallet is asked to send.

## Ondo

Ondo tokens can be paused (per token or all at once) and refuse blocked or sanctioned addresses.
`checkOndoTradable` reads `tokenPauseManager().isTokenPaused(token)` / `allTokensPaused()` for every Ondo
token on the route and `checkIsCompliant(account)` on the shared compliance view for the user.
Reasons: `paused`, `blocked`, `sanctioned` (blockers) and `market-closed` (a warning: the app's
New York market calendar says closed, so prices can be stale; `blockWhenClosed` makes it a blocker).
USDon has no pause manager and is treated as not paused.

## Privacy

Pool reads, fees and quotes are public data and use the public client. Balances, allowances and the
Ondo compliance check carry the user's address, so they use `createAccountClient` (private RPC under the
account's isolation key, no direct fallback). No address is sent to the indexer or any Varada server.
The wallet's own RPC sees the signed transaction (docs/PRIVACY.md).

## Limits

- Routes use Uniswap v4 pools without hooks only. Uniswap v3 and v2 liquidity, aggregators and
  hooked v4 pools (other than the Varada pool itself) are not searched, so an asset whose only liquidity
  is on v3 has no route. Adding v3 hops would need `V3_SWAP_EXACT_IN` and the v3 quoter.
- Pools with a fee or tick spacing outside `DEFAULT_FEE_TIERS` are invisible. Pass `feeTiers` to search
  more; every extra tier adds one `StateView` read per asset pair.
- At most three pool hops. Exact-out works for one v4 swap (optionally paid in ETH through a wrap);
  other shapes throw `exact-out-unsupported`. The panel uses exact-in.
- The quote is a simulation at the latest block, not a guarantee; the slippage limit and deadline are.
- TVL and market cap in `usePoolMarket` are estimated from the pool's liquidity, the price and the
  token's total supply (the launch position holds the whole supply), so they drift by any tokens that
  were burned. 24 h change and volume come from the indexer and are absent when it is unreachable.
- USD prices are mid prices of the shortest route to USDC (no oracle); an asset without a route has none.

## Tests

Unit tests (always run): `pnpm --filter @varada/sdk test` (pool keys, routing, calldata decoded
back to commands and actions, fees, Permit2 planning, error mapping, compliance, quotes with a mock
chain) and `pnpm --filter @varada/web test` (hooks and `ConnectedTradePanel`).

Fork tests (`packages/sdk/test/swap.fork.test.ts`, skipped unless `FORK_RPC_URL` is set) run against a
mainnet fork with real v4 pools, the real V4Quoter and Universal Router, and the Varada contracts
deployed on the fork:

```sh
# archive state is needed (the public ethereum.reth.rs node serves it); pin a block so reads are cached on disk
anvil --fork-url https://ethereum.reth.rs/rpc --fork-block-number <recent block> --chain-id 1 --port 8546 --code-size-limit 100000
# deploy the system with live mode, allowlist WETH and AMZNon, launch a weekly/WETH, a weekly/AMZNon and a live/WETH token
cd contracts && SWAP_FORK_FIXTURE=1 PLATFORM_TREASURY=<any address> forge script script/SwapForkFixture.s.sol \
  --sig "fixture()" --rpc-url http://127.0.0.1:8546 --broadcast --private-key <anvil account 0 key>
FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @varada/sdk exec vitest run test/swap.fork.test.ts \
  --testTimeout 900000 --hookTimeout 900000
```

The first run is slow (cold storage reads over the network); later runs read the cached state.
`evm_snapshot` stalls a fork with this much cached state, so the tests do not use snapshots: each one
measures balance deltas and the time-travel test runs last.
