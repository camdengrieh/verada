# SwapFeeHook

`contracts/src/hooks/fee/SwapFeeHook.sol` (abstract feature),
`contracts/src/hooks/examples/SwapFeeExample.sol` (deployable single-feature hook),
`contracts/test/hooks/fee/SwapFeeHook.t.sol` (tests).

## Purpose

A hook fee on every swap of a pool, on top of the LP fee. The fee is a rate in basis points of
the swap's **unspecified** side and is taken in `afterSwap` through the hook's return delta:

| Swap | Specified | Unspecified (charged) | Effect on the trader |
| --- | --- | --- | --- |
| exact input, zeroForOne | currency0 in | currency1 out | receives `out - fee` |
| exact input, oneForZero | currency1 in | currency0 out | receives `out - fee` |
| exact output, zeroForOne | currency1 out | currency0 in | pays `in + fee` |
| exact output, oneForZero | currency0 out | currency1 in | pays `in + fee` |

The specified amount is never touched, so the trader's exact input or exact output is honoured
exactly; the fee shows up in the amount the router checks against `amountOutMinimum` /
`amountInMaximum`.

The fee goes to a per-pool recipient, either as **ERC-6909 claims** minted by the pool manager
(no token transfer and no external code inside the swap; the recipient redeems later with
`PoolManager.burn` inside its own unlock) or as **tokens** (`PoolManager.take`). Any LP, launchpad
or protocol can use it: as is (`SwapFeeExample`) or composed with other features into one hook.

## Configuration

Per pool, by the pool admin (`PoolAdminHook`: the caller of `PoolManager.initialize` for that
pool, transferable, renounceable):

```solidity
function setSwapFee(PoolKey calldata key, uint16 feeBps, address recipient, bool asClaims)
    external onlyPoolAdmin(key);

mapping(PoolId => SwapFee) public swapFee; // struct SwapFee { uint16 feeBps; bool asClaims; address recipient; }
```

| Rule | Revert |
| --- | --- |
| `feeBps <= _maxSwapFeeBps()` (default 1_000 = 10%) and `<= 10_000` | `InvalidSwapFee(feeBps)` |
| `recipient != 0` when `feeBps != 0` | `InvalidFeeRecipient(0)` |
| `recipient == address(this)` only with `asClaims` (tokens taken to the hook would be stranded) | `InvalidFeeRecipient(hook)` |
| caller is the pool admin and `key.hooks == this` | `NotPoolAdmin(poolId, caller)` |

`setSwapFee` may be called again at any time; it replaces the config. `setSwapFee(key, 0, 0,
false)` turns the fee off. A pool that was never configured charges nothing. After the admin
renounces (`transferPoolAdmin(key, address(0))`) the config is frozen and keeps applying.

Events: `SwapFeeSet(PoolId indexed poolId, uint16 feeBps, address recipient, bool asClaims)` on
every config change, `SwapFeeTaken(PoolId indexed poolId, Currency indexed currency, address
indexed recipient, uint256 amount)` on every charged swap.

## Fee math

```
(currency, amount) = _unspecified(key, params, delta)   // BaseHook: |pool delta| of the unspecified side
bps = _swapFeeBps(sender, key, params)                  // default: swapFee[poolId].feeBps
fee = ceil(amount * bps / 10_000)                       // FullMath.mulDivRoundingUp
```

- `amount` is the pool's own swap delta (after the LP fee, before any hook delta), so a partial
  fill at the price limit is charged on what actually filled.
- Rounded up (the side the feature protects). `fee <= amount` for any `bps <= 10_000`.
- A fee of zero (no recipient, zero rate, or a zero unspecified amount) does nothing: no mint, no
  take, no event, zero delta.
- Settlement: `poolManager.mint(recipient, currency.toId(), fee)` when `asClaims`, else
  `poolManager.take(currency, recipient, fee)`. The hook returns `+fee` as its unspecified delta,
  so the hook's own balance in the pool manager nets to zero and the trader's delta carries the fee.

## Customization points

All `internal virtual`, override in the concrete hook:

| Function | Default | Typical override |
| --- | --- | --- |
| `_swapFeeBps(address sender, PoolKey calldata key, SwapParams calldata params) view returns (uint16)` | the stored `feeBps` | exemptions (`return 0` for a keeper or a fee collector's own swaps), a launch surcharge that decays (e.g. `LinearDecay`), volume or direction tiers. Must not exceed 10_000 or the swap reverts `InvalidSwapFee`. Only consulted when the pool has a non-zero recipient, so set a recipient (with `feeBps == 0` if the override supplies the whole rate). |
| `_maxSwapFeeBps() pure returns (uint16)` | `1_000` (10%) | raise or lower the setter cap (never above 10_000) |
| `_onSwapFeeTaken(address sender, PoolKey calldata key, Currency currency, uint256 amount, address recipient, bool asClaims)` | no-op | runs after settlement, inside the swap: account for claims the hook itself holds, convert them (`FeeConversionHook`), notify a collector |

`sender` is the caller of `PoolManager.swap` (a router, an aggregator or a contract), not the end
user.

## Permissions

`beforeInitialize` (from `PoolAdminHook`, records the admin), `afterSwap`, `afterSwapReturnDelta`.
The standalone `SwapFeeExample` must be deployed at an address that encodes exactly these three
flags (`Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG |
Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG`), mined with `script/HookMiner.sol`.

Works with static-fee and dynamic-fee pools; it does not touch the LP fee.

## Composition

Follows the rules in [DESIGN.md](DESIGN.md):

- `_afterSwap` calls `super` first and returns `(selector, superDelta + fee)`. The fee is computed
  from the pool's swap delta, never from another feature's delta, so two hook fees of 1% and 2%
  take 3% of the same base; the order of the inheritance list does not change the result.
- `_hookPermissions` calls `super` and sets only its own flags.
- Does not read `hookData` and does not use the swap lock.

A concrete hook that combines it with another feature re-declares every internal function that
two or more bases define (rule 6). Example from the tests (a decaying LP fee feature plus this
one):

```solidity
contract DecayThenSwapFee is MockDecayingFee, SwapFeeHook {
    constructor(IPoolManager m) BaseHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal pure override(MockDecayingFee, SwapFeeHook) returns (Hooks.Permissions memory)
    { return super._hookPermissions(p); }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal override(PoolAdminHook, MockDecayingFee) returns (bytes4)
    { return super._beforeInitialize(s, k, px); }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal override(BaseHook, MockDecayingFee) returns (bytes4, BeforeSwapDelta, uint24)
    { return super._beforeSwap(s, k, sp, d); }

    function _afterSwap(address s, PoolKey calldata k, SwapParams calldata sp, BalanceDelta bd,
        bytes calldata d)
        internal override(MockDecayingFee, SwapFeeHook) returns (bytes4, int128)
    { return super._afterSwap(s, k, sp, bd, d); }
}
```

In-swap conversion: set `recipient = address(hook)`, `asClaims = true`, and compose with
`FeeConversionHook`, whose glue overrides `_onSwapFeeTaken` to convert or hold the claims the hook
just received.

## Security notes

- Reverts this feature can add to a trader's swap:
  - `InvalidSwapFee(bps)` when an override of `_swapFeeBps` returns more than 10_000;
  - `SafeCastOverflow` / checked-arithmetic overflow when the fee (plus other features' deltas)
    does not fit `int128` (unreachable for real token amounts);
  - anything the token or the recipient does on `take` (token settlement only): a token that
    reverts on transfer to the recipient, or a native-currency recipient that rejects ETH, blocks
    every swap on the pool until the admin changes the config;
  - anything an `_onSwapFeeTaken` override reverts with.
- Prefer `asClaims`: minting claims runs no external code inside the swap. With token settlement a
  native-currency recipient (or a token with transfer callbacks) receives control in the middle of
  the swap, while the pool manager is unlocked; it can do anything an unlocked caller can, but it
  cannot change this swap's result or the fee already computed.
- The hook keeps nothing unless the recipient is the hook itself (claims only), so there is no
  stranded balance. Claims minted to the hook must be accounted for by the concrete hook (for
  example `FeeConversionHook`).
- The fee is visible to the router as a smaller output (exact-in) or a larger input (exact-out);
  trader slippage limits apply to the amount after the fee. Quoters that simulate the swap through
  the pool manager see the fee.
- The admin can change the rate at any time up to `_maxSwapFeeBps()`; a protocol that wants a
  fixed fee renounces the admin after configuring, or overrides `_isPoolAdmin`.
- Config entry points check `key.hooks == this`, so a pool of another hook cannot be configured
  through this one.

## Tests

`FOUNDRY_PROFILE=hooks forge test --match-path test/hooks/fee/SwapFeeHook.t.sol` (real
`PoolManager` and routers from v4-core `Deployers`, hooks placed at flag addresses with
`HookTest._deployHook`):

- permissions and address check, pool-manager-only callback;
- all four swap shapes, claims and tokens: only the unspecified side changes, by exactly the
  rounded-up fee; recipient balances; nothing left on the hook; event fields and accumulation;
- hook as its own claims recipient; unconfigured pool, zero rate, zero unspecified amount and a
  disabled fee charge nothing;
- fuzz over amount, rate, direction and exact-in/out: `fee == ceil(gross * bps / 10_000)`,
  `fee <= gross`;
- overrides in a harness: sender exemption, `_onSwapFeeTaken` arguments, override rate with a
  zero stored rate, override ignored without a recipient, override above 100% reverts, raised cap
  (100% takes the whole output);
- config validation, admin gating, foreign hook key, admin transfer and frozen config;
- a native-ETH pool: fee in ETH as tokens, fee in the token as claims;
- composition with a mock decaying LP fee feature in both inheritance orders: merged flags, the
  decayed LP fee override and both features' deltas apply, identical results in either order.
