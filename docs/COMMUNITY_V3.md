# Swapping through community Uniswap v3 pools

Most Ondo stock depth sits in Uniswap v3-style pools against USDC. The deepest ones (TSLAon, METAon,
PLTRon, SOFIon, MUon, HIMSon, TSMon) live in a non-canonical but unmodified UniswapV3Factory,
`0x00a38533c68327aBE0Cc265436e036066E2D6B38` (extra fee tiers 0.6/1/1.5/2/3/5%, owner renounced, hosts
only Ondo-token pools). The Universal Router hard-codes the canonical factory, so it cannot swap there.
`V3PoolSwapper` (`contracts/src/community/V3PoolSwapper.sol`) does.

## What it does

`swapExactIn(factory, tokenIn, tokenOut, fee, amountIn, minOut, sqrtPriceLimitX96, recipient, deadline)`

1. Checks the deadline, the factory allowlist and the pair, derives the pool with CREATE2 from
   `(factory, token0, token1, fee)` and the factory's init code hash, and requires code at that address.
2. Calls `pool.swap` with the recipient as the output receiver.
3. In `uniswapV3SwapCallback`, pays the owed input with `transferFrom(payer, pool, owed)`. The payer is the
   caller of `swapExactIn`, recorded in transient storage with the pool and a running cap of `amountIn`.
4. Checks the recipient's measured balance increase against `minOut` (not the pool's self-reported amounts).

The contract never holds tokens, never approves anything, and needs no Permit2. A price limit that stops the
swap early pulls only what was spent; the rest stays with the payer.

Callback guards: reverts outside a swap it started (`NotSwapping`), from any address but the pool of that
swap (`NotThePool`), when the pool asks for more than `amountIn` in total across callbacks (`OwedTooMuch`),
and on re-entry (`Reentered`).

## Allowlist: immutable, set at deploy

Factories and init code hashes are constructor arguments. There is no owner and no setter. Reasons:

- It is the smaller trust surface: no key can add a hostile factory later, so the swapper cannot become a
  generic "spend my approval" path. A factory change is a redeploy, and the consolidator is repointed by its
  owner, who already controls which route each fee takes (`QuoteRegistry`).
- The routes are owner-managed anyway, so the helper allowlist is a second, independent gate rather than the
  only one.

Cost: adding a factory needs a new helper deployment. That is rare and acceptable.

## Init code hash

Verified on a mainnet fork (`test_fork_communityPoolsMatchCanonicalInitCodeHash`): the community pools for
TSLAon (2%), METAon (1.5%) and the canonical SPYon pool all match `0xe34f199b...8b54`, the canonical v3
`POOL_INIT_CODE_HASH`, and `factory.getPool` agrees with the derived address. The SDK derivation
(`communityPoolAddress`) reproduces the live TSLAon pool address in a unit test.

## Trust assumptions (record honestly)

- No formal audit (time decision). The contract is small, has a unit suite with hostile pools, and fork
  tests; that is not an audit.
- The community factory operator (an EOA, `0xA534...F409`) cannot change existing pools (plain
  UniswapV3Pool code, factory owner is zero) but can create pools of any pair and seed deceptive ones.
  Mitigations: routes name an exact fee tier and are set by the registry owner; every swap carries a `minOut`
  from the caller's own reference price (the consolidator's reference-tick guard, the web ticket's quote);
  the helper accepts only pools with the verified init code hash.
- Ondo can pause tokens or blocklist the consolidator, the swapper or the pool at any time. A blocked
  transfer reverts the whole swap and nothing is left behind; the fee stays held and can be retried.
- The pools are shallow in places and a 2% tier is expensive. Fees are the price of depth; `minOut` bounds the
  loss, it does not make it zero.
- The swapper has no rescue path: tokens sent to it directly are lost.

## Using it

Consolidator (V3 hop, see `mvp/consolidator-v3`): approve the swapper for the hop amount, call
`swapExactIn` with `recipient = consolidator`, reset the approval to zero, and apply the usual reference
price guard to `minOut` and a full-fill check on `spent == amountIn`. `FeeHolder` in
`contracts/test/fork/V3PoolSwapperFork.t.sol` is the reference call sequence.

Web: `packages/sdk/src/swap/community-v3.ts` finds pools (`discoverFactoryPools`), computes a spot-based
`minOut` (`minOutFromSpot`) and builds one transaction plus the single approval it needs
(`buildCommunitySwap`). A zero `minOut` is refused.

## Gas (mainnet fork, approve + swap + approval reset, single hop, Ondo token to USDC)

| Pool | Gas |
| --- | --- |
| TSLAon / USDC, community 2% | ~156.9k |
| METAon / USDC, community 1.5% | ~156.8k |
| SPYon / USDC, canonical 0.3% | ~162.9k |

These include the token approvals and ERC-20 transfers, not only the swapper's own overhead (not measured
separately).
