# Access gates: PoolInitGateHook and LiquidityGateHook

Two independent, generic Uniswap v4 hooks that control **who** may use a pool. Each works on its
own and both compose with any other hook in `src/hooks` (see [DESIGN.md](DESIGN.md), "The
composition rule").

| Hook | Controls | Config scope | Flags |
| --- | --- | --- | --- |
| `PoolInitGateHook` | who may create a pool with this hook, and which pool keys are accepted | hook-level (internal setter, the concrete hook picks the access control) | `beforeInitialize` |
| `LiquidityGateHook` | who may add and/or remove liquidity in a pool | per pool, set by the pool admin | `beforeInitialize` (via `PoolAdminHook`), `beforeAddLiquidity`, `beforeRemoveLiquidity` |

Neither hook touches swaps or donations, so neither can make a trade revert.

Files:

- `contracts/src/hooks/access/PoolInitGateHook.sol`
- `contracts/src/hooks/access/LiquidityGateHook.sol`
- `contracts/src/hooks/examples/PoolInitGateExample.sol` (deployable, `Ownable`)
- `contracts/src/hooks/examples/LiquidityGateExample.sol` (deployable)
- `contracts/test/hooks/access/PoolInitGateHook.t.sol` (includes the composition test)
- `contracts/test/hooks/access/LiquidityGateHook.t.sol` (includes the locked liquidity recipe)

## Who is `sender`?

> **Both gates check the `sender` argument of the v4 callback, which is the contract or account
> that called the `PoolManager` (`initialize` or `modifyLiquidity`), not the end user.**

- For `beforeInitialize`, `sender` is the caller of `PoolManager.initialize`: an EOA, a factory
  contract, or a router if one is used to initialize.
- For `beforeAddLiquidity` / `beforeRemoveLiquidity`, `sender` is the caller of
  `PoolManager.modifyLiquidity`: the shared position manager, a router, or a dedicated locker or
  vault. Allowing the shared position manager (or any public router) allows **everyone** who uses
  it. To restrict end users, allow a dedicated contract that enforces its own rules, and gate on
  that.

## PoolInitGateHook

```solidity
abstract contract PoolInitGateHook is BaseHook
```

Only allowed initializers may create pools that use this hook. After the initializer check, an
overridable pool key rule runs.

### State and config

| Item | Description |
| --- | --- |
| `mapping(address => bool) public isPoolInitializer` | the default allowlist |
| `_setPoolInitializer(address account, bool allowed)` | internal; emits `PoolInitializerSet(account, allowed)`. The concrete hook exposes it behind its own access control |

With no initializer allowed, no pool can be created with the hook.

### Extension points

| Function | Default | Override for |
| --- | --- | --- |
| `_isAllowedInitializer(address sender) internal view virtual returns (bool)` | `isPoolInitializer[sender]` | a role registry, "any contract deployed by my factory", permissionless |
| `_validatePoolKey(PoolKey calldata key, uint160 sqrtPriceX96) internal view virtual` | no-op | currency rules (allowed quote list), fee or tick spacing rules, a starting price band. Revert `InvalidPoolKey()` |

`_validatePoolKey` is `view`. A **stateful** rule (for example one pool per token) reads its state
in `_validatePoolKey` and records it in the concrete hook's `_beforeInitialize`, after `super`:

```solidity
function _validatePoolKey(PoolKey calldata key, uint160) internal view override {
    if (!(key.currency0 == quote) && !(key.currency1 == quote)) revert InvalidPoolKey();
    if (hasPool[_token(key)]) revert InvalidPoolKey();
}

function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
    internal
    override
    returns (bytes4 selector)
{
    selector = super._beforeInitialize(sender, key, sqrtPriceX96); // gate + rule
    hasPool[_token(key)] = true;
}
```

(`QuoteRuleGate` in `PoolInitGateHook.t.sol` is this exact harness.)

### Callback

`_beforeInitialize(sender, key, sqrtPriceX96)`: `super` first, then revert
`InitializerNotAllowed(sender)` unless `_isAllowedInitializer(sender)`, then
`_validatePoolKey(key, sqrtPriceX96)`.

### Example

`PoolInitGateExample is PoolInitGateHook, Ownable`, constructor `(IPoolManager, address owner)`.
`setPoolInitializer(address account, bool allowed) external onlyOwner`. No key rule. Address flags:
`BEFORE_INITIALIZE_FLAG` only.

### Reverts it adds

| Where | Error |
| --- | --- |
| `PoolManager.initialize` | `InitializerNotAllowed(address sender)`, `InvalidPoolKey()` (from the rule) |

The pool manager wraps hook reverts in `CustomRevert.WrappedError(hook, selector, reason,
HookCallFailed())`.

## LiquidityGateHook

```solidity
abstract contract LiquidityGateHook is PoolAdminHook
```

Optional per-pool allowlist for adding and/or removing liquidity, each side gated separately. The
pool admin (the account the concrete hook's `_initialPoolAdmin` records, see `PoolAdminHook`)
configures it.
A pool with no gate set behaves like a plain pool.

### State

| Item | Description |
| --- | --- |
| `mapping(PoolId => LiquidityGate) public liquidityGate` | `struct LiquidityGate { bool gateAdd; bool gateRemove; }`, both false by default |
| `mapping(PoolId => mapping(address => bool)) public isLiquidityProvider` | senders allowed on the gated sides (one list for both sides) |

### Config (pool admin only, `onlyPoolAdmin(key)`)

| Function | Effect |
| --- | --- |
| `setLiquidityGate(PoolKey calldata key, bool gateAdd, bool gateRemove)` | sets which sides are gated; emits `LiquidityGateSet(poolId, gateAdd, gateRemove)` |
| `setLiquidityProvider(PoolKey calldata key, address account, bool allowed)` | allows or disallows a sender; emits `LiquidityProviderSet(poolId, account, allowed)` |
| `transferPoolAdmin(PoolKey calldata key, address newAdmin)` (from `PoolAdminHook`) | hands the role over; `address(0)` renounces it and freezes the gate and the list |

Config entry points revert `NotPoolAdmin(poolId, caller)` for anyone else, and for a key whose
`hooks` is not this hook.

### Extension point

`_isLiquidityAllowed(address sender, PoolKey calldata key, bool isAdd) internal view virtual
returns (bool)`: default "side not gated, or sender on the list". Override for time locks,
separate lists per side, or an external registry.

### Callbacks

`_beforeAddLiquidity` and `_beforeRemoveLiquidity`: `super` first, then revert
`LiquidityNotAllowed(poolId, sender)` when that side is gated and `sender` is not allowed.

### Fee collection goes through the removal gate

v4 routes `modifyLiquidity` with `liquidityDelta == 0` (collecting a position's fees) through
`beforeRemoveLiquidity`. Gating removal therefore also blocks fee collection for senders that are
not allowed. If the allowed sender is later disallowed and the admin renounces, the position's fees
can never be collected.

### Example

`LiquidityGateExample is PoolInitGateHook, LiquidityGateHook, Ownable`, constructor
`(IPoolManager, address owner)`. Only initializers the owner allows (`setPoolInitializer`) may
create a pool, and the initializer becomes its admin. Without the init gate, anyone could
initialize the key you plan to use first and control its liquidity gate. Address flags: `BEFORE_INITIALIZE_FLAG | BEFORE_ADD_LIQUIDITY_FLAG |
BEFORE_REMOVE_LIQUIDITY_FLAG`.

### Reverts it adds

| Where | Error |
| --- | --- |
| `PoolManager.modifyLiquidity` (add) | `LiquidityNotAllowed(PoolId poolId, address sender)` when `gateAdd` |
| `PoolManager.modifyLiquidity` (remove or collect) | `LiquidityNotAllowed(PoolId poolId, address sender)` when `gateRemove` |
| config | `NotPoolAdmin(PoolId poolId, address caller)` |

## Recipe: locked launch liquidity

Liquidity that nobody can ever pull, while trading and fee collection keep working.

1. The pool admin calls `setLiquidityGate(key, true, true)`.
2. The admin allows the locker: `setLiquidityProvider(key, locker, true)`. The locker is a contract
   that calls `PoolManager.modifyLiquidity` itself, can add a position and collect its fees, and
   **has no code path that removes liquidity**.
3. The locker adds the position.
4. The admin renounces: `transferPoolAdmin(key, address(0))`.

After step 4 nobody can change the gate or the list (the admin is zero), no other sender can add
or remove, and the locker cannot remove because its code does not allow it. The locker still
collects fees through zero-delta `modifyLiquidity` calls, which pass the removal gate because the
locker is on the list.

Stricter variant (no fee collection at all): disallow the locker before renouncing. Then nobody,
including the locker, can remove liquidity or collect fees, forever.

`test_lockedLiquidityRecipe` in `LiquidityGateHook.t.sol` runs this flow against the real
`PoolManager`: removal and addition through the public router revert, config reverts, a swap
succeeds, and the locker collects its fees with the position unchanged.

## Composing both gates

```solidity
contract GatedLaunchHook is PoolInitGateHook, LiquidityGateHook /*, other features */ {
    constructor(IPoolManager m) BaseHook(m) {}

    // the initializer passed the gate, so it may be the pool admin
    function _initialPoolAdmin(address s, PoolKey calldata) internal pure override returns (address)
    { return s; }

    // rule 6: re-declare every internal function two or more bases define
    function _hookPermissions(Hooks.Permissions memory p)
        internal pure override(PoolInitGateHook, LiquidityGateHook)
        returns (Hooks.Permissions memory) { return super._hookPermissions(p); }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal override(PoolInitGateHook, PoolAdminHook)
        returns (bytes4) { return super._beforeInitialize(s, k, px); }

    function _beforeAddLiquidity(address s, PoolKey calldata k,
        ModifyLiquidityParams calldata p, bytes calldata d)
        internal override(BaseHook, LiquidityGateHook)
        returns (bytes4) { return super._beforeAddLiquidity(s, k, p, d); }

    function _beforeRemoveLiquidity(address s, PoolKey calldata k,
        ModifyLiquidityParams calldata p, bytes calldata d)
        internal override(BaseHook, LiquidityGateHook)
        returns (bytes4) { return super._beforeRemoveLiquidity(s, k, p, d); }
}
```

- Permissions merge to `beforeInitialize | beforeAddLiquidity | beforeRemoveLiquidity`.
- The linearization is `GatedLaunchHook, LiquidityGateHook, PoolAdminHook, PoolInitGateHook,
  BaseHook`, so in `beforeInitialize` the initializer gate and key rule run first and the pool
  admin is recorded only if they pass. With this order the allowed initializer (for example a
  factory) becomes the admin of every pool it creates, configures the gate, and renounces. The
  concrete hook implements `_initialPoolAdmin` as `return sender`, which is safe because only
  allowed initializers reach it.
- `BothGatesHook` in `PoolInitGateHook.t.sol` is this composition; its tests check the merged
  flags, that a refused initializer records no admin, and that both `beforeInitialize` logics run.

## Security notes

- Callbacks are pool-manager only (`BaseHook`). Config entry points check `key.hooks == this`.
- No funds move; no external calls; no `hookData` is read.
- `sender` is the immediate caller of the pool manager (see above). This is the single most
  important point when choosing what to allow.
- The initializer allowlist is hook-level and controlled by the concrete hook's owner scheme; the
  example uses `Ownable`. An owner can add initializers at any time but cannot affect existing
  pools.
- The liquidity gate is per pool and controlled by the pool admin. Renouncing is final.
- Gating removal also gates fee collection (zero-delta modify).
- Donations are not gated. A protocol that refuses donations adds a one-line `_beforeDonate`
  revert in its concrete hook.
