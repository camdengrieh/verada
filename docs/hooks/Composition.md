# Composing feature hooks into one hook

A Uniswap v4 pool has exactly one hook address. The hooks in `contracts/src/hooks` are therefore
written as **features**: abstract contracts that each do one thing and can be inherited together
into a single concrete hook. This page shows how to do that, step by step, using
`contracts/src/hooks/examples/LaunchpadHook.sol` as the worked example, and how a protocol adds
its own rules on top without editing any feature.

The rules themselves are stated in [DESIGN.md](./DESIGN.md) ("The composition rule") and in the
NatSpec of `contracts/src/hooks/base/BaseHook.sol`. Each feature has its own page:
[DecayingFeeHook](./DecayingFeeHook.md), [SwapFeeHook](./SwapFeeHook.md),
[TwapOracleHook](./TwapOracleHook.md), [AccessGates](./AccessGates.md) (`PoolInitGateHook`,
`LiquidityGateHook`).

## The worked example: LaunchpadHook

`LaunchpadHook` is a generic token-launch hook that any launchpad or LP can deploy as is:

| Need | Feature | What it contributes |
| --- | --- | --- |
| Only a launch factory may create pools | `PoolInitGateHook` | `beforeInitialize`: reverts `InitializerNotAllowed` unless the owner allowed the caller |
| Launch liquidity cannot be pulled | `LiquidityGateHook` | `beforeAddLiquidity` / `beforeRemoveLiquidity`: per-pool allowlist set by the pool admin |
| A manipulation-resistant price | `TwapOracleHook` | `afterInitialize` seeds, `beforeSwap` accrues; `twapTick(poolId, window)` |
| Anti-sniper launch fee that pays LPs | `DecayingFeeHook` | `beforeSwap` LP fee override, decaying from `startFee` to `endFee` |
| A protocol or creator fee | `SwapFeeHook` | `afterSwap` return delta on the unspecified currency, paid to a per-pool recipient |

```solidity
contract LaunchpadHook is
    PoolInitGateHook,
    LiquidityGateHook,
    TwapOracleHook,
    DecayingFeeHook,
    SwapFeeHook,
    Ownable
{
    constructor(IPoolManager manager, address owner_)
        BaseHook(manager)
        TwapOracleHook(5 minutes, 24)
        Ownable(owner_)
    {}

    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    // rule 6 boilerplate below
}
```

## Step by step

### 1. Pick the features and their order

List the features in the order their logic should run. Each feature calls `super` first, so for
`is A, B, C` the logic of A runs, then B, then C, with `BaseHook` at the root of every chain.

Order matters only for side effects that depend on each other (one feature reading state another
wrote in the same callback). It never changes the merged results:

- LP fee overrides are merged by `_mergeLpFeeOverride`: an override always beats "no override",
  and of two overrides the higher fee wins. The merge is commutative.
- `afterSwap` and liquidity deltas are summed, and every feature computes its own delta from the
  pool's swap or liquidity delta (never from another feature's), so two hook fees of 1% and 2%
  take 3% of the same base.

The integration test proves this: `LaunchpadHookFeesSwappedTest` runs the full suite against a
copy of `LaunchpadHook` with `SwapFeeHook` and `DecayingFeeHook` in the opposite order and gets
identical fees, balances and TWAPs.

In `LaunchpadHook` the order puts the gates first (a disallowed initializer fails before any other
feature does work), the oracle before the fees (it reads `slot0` before the swap moves it; the
fee features do not touch the price), and the fees last.

### 2. Call the constructors

- `BaseHook(manager)` exactly once, from the concrete contract (every feature inherits it).
- Each feature that takes arguments, e.g. `TwapOracleHook(observationInterval,
  observationCapacity)`.
- Whatever access control the concrete hook chooses for hook-level config (here
  `Ownable(owner_)`). Features never pick an access-control scheme.

The `BaseHook` constructor computes the merged permissions and reverts
`Hooks.HookAddressNotValid(address)` unless the deployed address encodes exactly those flags
(step 5).

### 3. Expose hook-level config

Features keep hook-wide settings behind `internal` setters. The concrete hook decides who may call
them. `LaunchpadHook` exposes one:

```solidity
function setPoolInitializer(address account, bool allowed) external onlyOwner {
    _setPoolInitializer(account, allowed);
}
```

Per-pool config (`setDecayingFee`, `setSwapFee`, `setLiquidityGate`, `setLiquidityProvider`,
`transferPoolAdmin`) is already external on the features and guarded by `onlyPoolAdmin(key)`:
the account that called `PoolManager.initialize` for that pool. Nothing to add.

### 4. Re-declare every shared override (rule 6)

Solidity requires the concrete contract to override every internal function that two or more of
its bases define, and the body must only call `super`. The C3 linearization then calls each
feature exactly once.

The `override(...)` list names every base whose definition is still "open" from the concrete
contract: a base that defines the function and is reached through at least one inheritance path
on which no other base overrides it. In practice:

- every feature that defines the function is listed;
- `BaseHook` is listed when at least one inherited feature does **not** define the function (that
  feature's path reaches `BaseHook`'s definition directly);
- `PoolAdminHook` is listed when it defines the function and some feature that inherits it does
  not;
- a base that every path overrides must **not** be listed (`Invalid contracts specified in
  override list`).

For `LaunchpadHook`:

| Function | `override(...)` |
| --- | --- |
| `_hookPermissions` | `PoolInitGateHook, LiquidityGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook` (every feature defines it, so neither `BaseHook` nor `PoolAdminHook` is open) |
| `_beforeInitialize` | `BaseHook, PoolAdminHook, PoolInitGateHook, DecayingFeeHook` |
| `_afterInitialize` | `BaseHook, TwapOracleHook` |
| `_beforeAddLiquidity`, `_beforeRemoveLiquidity` | `BaseHook, LiquidityGateHook` |
| `_beforeSwap` | `BaseHook, TwapOracleHook, DecayingFeeHook` |
| `_afterSwap` | `BaseHook, SwapFeeHook` |

A function with a single defining feature (`_afterSwap` here) still needs the re-declaration,
because the other features reach `BaseHook`'s definition along their own paths. The compiler
names every missing or invalid base, so the quickest route is to write the list you expect,
compile, and follow the errors.

The boilerplate looks the same for every callback:

```solidity
function _beforeSwap(
    address sender,
    PoolKey calldata key,
    SwapParams calldata params,
    bytes calldata hookData
)
    internal
    virtual
    override(BaseHook, TwapOracleHook, DecayingFeeHook)
    returns (bytes4, BeforeSwapDelta, uint24)
{
    return super._beforeSwap(sender, key, params, hookData);
}
```

Keep the re-declarations `virtual` so the concrete hook can itself be extended.
`FlooredLaunchpadHook` in the integration test is `LaunchpadHook, LpFeeFloorStub`: the stub opens
a second path to `BaseHook`, so every callback is re-declared once more with
`override(BaseHook, LaunchpadHook)`, and `_beforeSwap` with `override(LaunchpadHook,
LpFeeFloorStub)`. Never put logic in these bodies: logic belongs in
a feature, or in protocol glue that overrides a feature's extension point (see below).

### 5. Mine the hook address

Uniswap v4 reads a hook's permissions from the low 14 bits of its address. The address must
encode the merged flags of all features exactly, no more and no fewer. For `LaunchpadHook`:

```
BEFORE_INITIALIZE | AFTER_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY
  | BEFORE_SWAP | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
```

Read them from the contract rather than by hand: `getHookPermissions()` is `pure`, so a script can
compute the flags before deploying (see `HookTest._flags` for the struct-to-bits mapping).

`contracts/script/HookMiner.sol` finds a CREATE2 salt:

```solidity
uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
    | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
    | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
bytes memory args = abi.encode(poolManager, owner);
(address predicted, bytes32 salt) =
    HookMiner.find(CREATE2_DEPLOYER, flags, type(LaunchpadHook).creationCode, args);
LaunchpadHook hook = new LaunchpadHook{salt: salt}(poolManager, owner);
require(address(hook) == predicted);
```

`deployer` is whoever executes the CREATE2: the contract calling `new` or, in a `forge script`
broadcast, the standard CREATE2 deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`). The
constructor arguments are part of the init code, so mine with the exact arguments you deploy with.
Seven flags take about 2^14 attempts on average (well within the default bound).

In tests, `HookTest._deployHook("File.sol:Contract", args, flags)` places the hook at a flag
address directly; `test_constructor_minedSaltDeploys` exercises the miner end to end.

### 6. Test the composition

Extend `contracts/test/hooks/utils/HookTest.sol` (real `PoolManager` and routers) and cover at
least: the merged permission set and a wrong address failing the constructor; each feature's
effect through a real swap or liquidity call; reverts surfacing as
`CustomRevert.WrappedError(hook, callbackSelector, reason, HookCallFailed)`; and a second concrete
with a different feature order. `contracts/test/hooks/integration/LaunchpadHook.t.sol` is the
template.

```
cd contracts
FOUNDRY_PROFILE=hooks forge test --match-path 'test/hooks/integration/*'
```

`FOUNDRY_PROFILE=hooks forge build` also compiles `script/`, where the production deploy script
needs `via_ir`; build the hooks alone with `FOUNDRY_PROFILE=hooks FOUNDRY_SCRIPT=test/hooks forge
build` (`forge test` is unaffected).

## Running a launch with LaunchpadHook

All pool config happens while the factory is the pool admin, then the factory renounces:

1. Owner: `setPoolInitializer(factory, true)`.
2. Factory: `PoolManager.initialize(key, sqrtPriceX96)` with
   `key.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG` (a static fee reverts `NotDynamicFee`) and
   `key.hooks = launchpadHook`. The factory is now the pool admin.
3. Factory: `setDecayingFee(key, startFee, endFee, duration, 0)`, `setSwapFee(key, bps,
   recipient, true)` (claims; see the checklist), `setLiquidityGate(key, true, true)`,
   `setLiquidityProvider(key, locker, true)`.
4. Locker: adds the launch position. Single-sided launch liquidity is a range entirely on one side
   of the initial price (for example `[tickSpacing, maxUsableTick]` above an initial tick of 0
   when the token is currency0), so it holds only the token. The locker is a contract with no
   removal path.
5. Factory: `transferPoolAdmin(key, address(0))`. From here no one can change the fee schedule,
   the hook fee, the gate or the allowed providers, and no one can remove the liquidity: the gate
   rejects every other `modifyLiquidity` caller and the locker cannot.

`LiquidityGateHook` sees the caller of `PoolManager.modifyLiquidity` (a router, position manager
or locker), not the end user. Allowing a public router or the position manager would let anyone
add or remove through it; allow only a contract whose own rules you trust.

## Deployment checklist

- [ ] Every shared internal function is re-declared with every defining base and a `super`-only
      body; the contract compiles without warnings under the production profile
      (`cd contracts && forge build`, `via_ir`).
- [ ] `getHookPermissions()` matches the intended flags; no feature adds a flag you did not expect
      (each feature's doc page lists its flags).
- [ ] The salt was mined for the exact init code (creation code and constructor arguments) and the
      deployer that will execute the CREATE2; the deployed address equals the prediction.
- [ ] The `poolManager` argument is the Ethereum mainnet `PoolManager`.
- [ ] Hook-level config is behind the access control you intend (`onlyOwner` here) and the owner
      is the intended account (a multisig for production). Plan who allows initializers.
- [ ] Pools are created with a dynamic-fee key when `DecayingFeeHook` is present.
- [ ] The pool admin of each pool is the account you expect (`poolAdmin(poolId)`), configures the
      pool, and renounces or transfers when done.
- [ ] Hook fee recipients are set; tokens to `address(this)` are refused unless as claims.
- [ ] Token settlement (`asClaims = false`) takes the fee out of the pool manager during the swap.
      On an exact-output swap the fee is in the input currency, so the manager must already hold
      enough of it: the first exact-output buy of a fresh single-sided pool reverts
      (`test_swap_hookFeeAsTokensExactOutOnFreshPoolReverts`). Pay fees as claims for launches.
- [ ] Oracle consumers use a window no longer than `observationInterval * observationCapacity`
      and handle `ok == false`.
- [ ] Every revert a feature can add to a trader's swap is acceptable (see each feature's page).
- [ ] The integration tests pass for the exact feature list and order you deploy.

## Adding protocol glue

A protocol does not fork a feature. It inherits the concrete composition (or the features
directly) and overrides the features' `internal virtual` extension points. Each override should
call `super` when it narrows rather than replaces the default.

### Factory-only pool admin: `_isPoolAdmin`

By default the pool admin is whoever initialized the pool and can be handed over. A protocol that
wants its factory to remain the sole configurator of every pool, even after an accidental
transfer, overrides the rule:

```solidity
contract MyLaunchHook is LaunchpadHook {
    address public immutable factory;

    constructor(IPoolManager m, address owner_, address factory_) LaunchpadHook(m, owner_) {
        factory = factory_;
    }

    function _isPoolAdmin(PoolId poolId, address account)
        internal
        view
        override
        returns (bool)
    {
        return account == factory && super._isPoolAdmin(poolId, account);
    }
}
```

`_initialPoolAdmin(sender, key)` can likewise record a different admin (for example the token
creator a factory passes in) when the pool is created. A per-token rule such as "one pool per
token" or "quote must be on an allowed list" goes in `_validatePoolKey(key, sqrtPriceX96)`
(reverting `InvalidPoolKey()`).

### A fee exemption or a dynamic hook fee: `_swapFeeBps`

`SwapFeeHook` asks `_swapFeeBps(sender, key, params)` for the rate of every swap. Override it to
exempt an account (a fee consolidator swapping its own fees, a market maker), to add tiers, or to
decay a surcharge with `LinearDecay`:

```solidity
function _swapFeeBps(address sender, PoolKey calldata key, SwapParams calldata params)
    internal
    view
    override
    returns (uint16)
{
    if (sender == exemptRouter) return 0;
    return super._swapFeeBps(sender, key, params);
}
```

`sender` is the caller of `PoolManager.swap` (a router), not the end user.

### Routing the hook fee: `_onSwapFeeTaken`

After the fee is paid to the recipient, `_onSwapFeeTaken(sender, key, currency, amount,
recipient, asClaims)` runs inside the swap. Use it to notify an accounting contract or credit a
vault. Keep it cheap and non-reverting where possible: anything it reverts reverts the trader's
swap. Prefer `asClaims = true` (ERC-6909 claims, no token transfer and no external code inside
the swap) and let the recipient redeem later, or compose `FeeConversionHook` to convert the claims
in the same swap with a price guard and a hold-and-retry fallback.

```solidity
function _onSwapFeeTaken(
    address sender,
    PoolKey calldata key,
    Currency currency,
    uint256 amount,
    address recipient,
    bool asClaims
) internal override {
    super._onSwapFeeTaken(sender, key, currency, amount, recipient, asClaims);
    feeLedger.record(key.toId(), currency, amount);
}
```

### Behaviour no feature provides

Add it as a small feature of your own (an abstract contract on `BaseHook` that sets its flag in
`_hookPermissions` and calls `super` first in its callback), then inherit it and add it to the
rule 6 lists. For example, refusing donations is a `beforeDonate` feature that reverts; the
integration test's `LpFeeFloorStub` is a complete three-line LP fee floor feature.
