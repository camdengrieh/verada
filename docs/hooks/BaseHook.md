# BaseHook and PoolAdminHook

The two shared contracts every feature builds on.

- `contracts/src/hooks/base/BaseHook.sol`: `abstract contract BaseHook is IHooks`
- `contracts/src/hooks/base/PoolAdminHook.sol`: `abstract contract PoolAdminHook is BaseHook`
- Tests: `contracts/test/hooks/base/BaseHook.t.sol`

You do not deploy either directly. You write a feature on `BaseHook` (or on `PoolAdminHook` when
the feature has per pool config), or you inherit existing features into a concrete hook.

## BaseHook

### What it does

- Implements all ten `IHooks` callbacks as `external onlyPoolManager` functions that forward to
  `internal virtual` functions of the same name with a leading underscore (`beforeSwap` calls
  `_beforeSwap`). Features override the internal functions only.
- At the root of every chain, returns the neutral result (the selector, a zero delta, no LP fee
  override) when the hook's address enables that callback, and reverts `HookNotImplemented()`
  when it does not.
- Computes the merged permissions (`getHookPermissions()`, `pure`) from `_hookPermissions` and
  checks in the constructor that the deployed address encodes exactly that set
  (`Hooks.validateHookPermissions`, reverting `Hooks.HookAddressNotValid(address)`).
- Holds one transient lock slot shared by all features.

### Constructor

```solidity
constructor(IPoolManager poolManager_)
```

Call it exactly once, from the concrete hook: `contract H is A, B { constructor(IPoolManager m)
BaseHook(m) {} }`. Reverts `ZeroPoolManager()` for the zero address and
`SwapLockNeedsSwapCallbacks()` when a feature enables the swap lock without both swap flags.

### Extension points for feature authors

| Function | Rule |
| --- | --- |
| `_hookPermissions(Hooks.Permissions memory p) internal pure virtual returns (Hooks.Permissions memory)` | call `super`, then set (never clear) your flags |
| `_beforeInitialize`, `_afterInitialize`, `_beforeAddLiquidity`, `_afterAddLiquidity`, `_beforeRemoveLiquidity`, `_afterRemoveLiquidity`, `_beforeSwap`, `_afterSwap`, `_beforeDonate`, `_afterDonate` | call `super` first, then do your work and combine your result with super's (below) |
| `_usesSwapLock() internal pure virtual returns (bool)` | return `true` (or `super._usesSwapLock() \|\| true`) to hold the lock from `beforeSwap` to `afterSwap` |
| `_validateHookAddress(Hooks.Permissions memory) internal view virtual` | override only in test harnesses |

Combining results:

| Callback result | Merge |
| --- | --- |
| selector | pass on super's |
| `afterSwap`, `afterAddLiquidity`, `afterRemoveLiquidity` delta | `superDelta + ownDelta` (checked) |
| `beforeSwap` delta | `_addBeforeSwapDelta(superDelta, ownDelta)` (component-wise, checked) |
| `beforeSwap` LP fee override | `_mergeLpFeeOverride(superFee, ownFee)`: a value without `LPFeeLibrary.OVERRIDE_FEE_FLAG` never replaces one with it; of two overrides the higher fee wins; commutative |

Compute your own delta from the callback arguments (the pool's swap or liquidity delta), never
from another feature's delta, so fees stack additively.

### Helpers

| Helper | Returns |
| --- | --- |
| `_specifiedIsCurrency0(SwapParams calldata)` | whether the specified currency is currency0 (`(amountSpecified < 0) == zeroForOne`) |
| `_unspecified(PoolKey calldata, SwapParams calldata, BalanceDelta)` | `(Currency, uint256 absAmount)` of the unspecified side: output of exact-in, input of exact-out |
| `_hasFlag(uint160 flag)` | whether this hook's address enables a `Hooks.*_FLAG` |
| `_hookLockState()` | the shared lock state |

### The shared lock

One transient storage slot (`HOOK_LOCK_SLOT`, EIP-1153, cleared at the end of every transaction):

| State | Constant | Held by |
| --- | --- | --- |
| 0 | `LOCK_IDLE` | nobody |
| 1 | `LOCK_SWAP` | the swap span, from `beforeSwap` to `afterSwap`, when any feature's `_usesSwapLock()` is true |
| 2 | `LOCK_CALL` | an external entry point marked `hookNonReentrant` (retries, claims, admin actions that unlock the pool manager) |

While the lock is held in either state, a swap on any pool of the hook (when the swap lock is
enabled) and every `hookNonReentrant` entry point revert `HookReentered(state)`. A feature's
`unlockCallback` can require `_hookLockState() == LOCK_CALL` so it only runs for its own unlock.

### Errors

| Error | When |
| --- | --- |
| `NotPoolManager()` | a callback not called by the pool manager |
| `HookNotImplemented()` | a callback whose flag is not set on this address (unreachable through the pool manager) |
| `HookReentered(uint256 state)` | nested swap under the swap lock, or a `hookNonReentrant` call while the lock is held |
| `SwapLockNeedsSwapCallbacks()` | constructor: swap lock enabled without `beforeSwap` and `afterSwap` |
| `ZeroPoolManager()` | constructor: zero pool manager |

`BaseHook` emits no events.

### Writing a feature: a complete example

A feature that refuses donations, in full (compiled and tested in the compose tutorial):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BaseHook} from "v4-hooks/base/BaseHook.sol";

abstract contract NoDonateHook is BaseHook {
    error DonateNotAllowed();

    function _hookPermissions(Hooks.Permissions memory p)
        internal pure virtual override returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeDonate = true;
        return p;
    }

    function _beforeDonate(address sender, PoolKey calldata key, uint256 amount0, uint256 amount1,
        bytes calldata hookData) internal virtual override returns (bytes4 selector)
    {
        selector = super._beforeDonate(sender, key, amount0, amount1, hookData);
        revert DonateNotAllowed();
    }
}
```

## PoolAdminHook

Per pool configuration needs an owner per pool. `PoolAdminHook` records one when the pool is
created and gives features an `onlyPoolAdmin(key)` modifier.

### Behaviour

- `beforeInitialize` (flag set by this contract): records `_initialPoolAdmin(sender, key)` as the
  admin of the pool, where `sender` is the caller of `PoolManager.initialize` (an EOA, a factory,
  or a multicall). Emits `PoolAdminChanged(poolId, address(0), admin)`.
- `onlyPoolAdmin(PoolKey calldata key)`: reverts `NotPoolAdmin(poolId, caller)` unless
  `key.hooks == this` and `_isPoolAdmin(poolId, msg.sender)`.
- A pool with no config behaves neutrally in every feature (no fee, no gate).

Because the admin only exists once the pool is initialized, initialize and configure **in the
same transaction** (from a factory or a multicall contract) when the gap matters, for example a
launch fee that must apply to the first swap.

### API

| Item | Description |
| --- | --- |
| `poolAdmin(PoolId) returns (address)` | the admin; zero before initialization or after renouncing |
| `transferPoolAdmin(PoolKey calldata key, address newAdmin)` | admin only; `newAdmin == address(0)` renounces and freezes every feature's config for that pool |
| `_isPoolAdmin(PoolId, address) internal view virtual returns (bool)` | default: `account != 0 && poolAdmin[id] == account`. Override for factory-only control, roles or multisigs |
| `_initialPoolAdmin(address sender, PoolKey calldata) internal view virtual returns (address)` | default: `sender`. Override to record someone else (a token creator a factory passes on) |

Event: `PoolAdminChanged(PoolId indexed poolId, address indexed previousAdmin, address indexed
newAdmin)`. Error: `NotPoolAdmin(PoolId poolId, address caller)`.

### Security notes

- Whoever can call `PoolManager.initialize` for a key with this hook becomes that pool's admin.
  If only some accounts should create pools, compose `PoolInitGateHook` (it runs before the admin
  is recorded when listed first, so a refused initializer records nothing).
- The admin is per pool. One hook can serve many pools with different admins and configs.
- Renouncing is final. Traders who need fixed terms check `poolAdmin(poolId) == address(0)` or
  that the admin is a contract that cannot change them.
