// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {PoolAdminHook} from "../base/PoolAdminHook.sol";

/// @title LiquidityGateHook
/// @notice Optional per-pool allowlist for who may add and/or remove liquidity. Each side is
///         gated separately by the pool admin. Typical use: locked launch liquidity (only a
///         locker may hold a position, then the admin renounces), or a private pool.
/// @dev IMPORTANT: the address that is checked is `sender` of the liquidity callbacks, i.e. the
///      contract that called `PoolManager.modifyLiquidity` (the position manager, a router or a
///      locker), NOT the end user. Allowing the shared position manager or a public router
///      allows everyone who uses it. Gate on a dedicated contract (a locker or a vault) that
///      enforces its own rules about end users.
///
///      v4 routes a `modifyLiquidity` with `liquidityDelta == 0` (fee collection) through
///      `beforeRemoveLiquidity`, so gating removal also gates fee collection for senders that are
///      not allowed.
///
///      Contributes `beforeInitialize` (through `PoolAdminHook`), `beforeAddLiquidity` and
///      `beforeRemoveLiquidity`. A pool with no gate set behaves neutrally (anyone may add and
///      remove).
abstract contract LiquidityGateHook is PoolAdminHook {
    /// @notice Which sides of a pool's liquidity are gated.
    struct LiquidityGate {
        bool gateAdd;
        bool gateRemove;
    }

    /// @notice Gate of each pool (both sides open by default).
    mapping(PoolId => LiquidityGate) public liquidityGate;
    /// @notice Senders allowed to modify liquidity on a gated side of each pool.
    mapping(PoolId => mapping(address account => bool)) public isLiquidityProvider;

    /// @notice The gate of `poolId` changed.
    event LiquidityGateSet(PoolId indexed poolId, bool gateAdd, bool gateRemove);
    /// @notice `account` was allowed or disallowed as a liquidity provider of `poolId`.
    event LiquidityProviderSet(PoolId indexed poolId, address indexed account, bool allowed);

    /// @notice `sender` may not modify liquidity on the gated side of `poolId`.
    error LiquidityNotAllowed(PoolId poolId, address sender);

    /// @notice Sets which sides of `key`'s pool are gated. Pool admin only.
    /// @param key The pool (its `hooks` must be this hook).
    /// @param gateAdd Whether adding liquidity requires an allowed sender.
    /// @param gateRemove Whether removing liquidity (and collecting fees) requires an allowed
    ///        sender.
    function setLiquidityGate(PoolKey calldata key, bool gateAdd, bool gateRemove)
        external
        onlyPoolAdmin(key)
    {
        PoolId id = key.toId();
        liquidityGate[id] = LiquidityGate({gateAdd: gateAdd, gateRemove: gateRemove});
        emit LiquidityGateSet(id, gateAdd, gateRemove);
    }

    /// @notice Allows or disallows `account` to modify liquidity on the gated sides of `key`'s
    ///         pool. Pool admin only.
    /// @param key The pool (its `hooks` must be this hook).
    /// @param account The caller of `PoolManager.modifyLiquidity` (a position manager, router or
    ///        locker contract), not an end user.
    /// @param allowed Whether `account` is allowed.
    function setLiquidityProvider(PoolKey calldata key, address account, bool allowed)
        external
        onlyPoolAdmin(key)
    {
        PoolId id = key.toId();
        isLiquidityProvider[id][account] = allowed;
        emit LiquidityProviderSet(id, account, allowed);
    }

    /// @dev Whether `sender` may modify liquidity of `key`'s pool on the side given by `isAdd`.
    ///      Default: allowed when that side is not gated, else the allowlist. Override for other
    ///      rules (time locks, per-side lists, an external registry).
    function _isLiquidityAllowed(address sender, PoolKey calldata key, bool isAdd)
        internal
        view
        virtual
        returns (bool)
    {
        PoolId id = key.toId();
        LiquidityGate memory g = liquidityGate[id];
        if (!(isAdd ? g.gateAdd : g.gateRemove)) return true;
        return isLiquidityProvider[id][sender];
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        return p;
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector) {
        selector = super._beforeAddLiquidity(sender, key, params, hookData);
        if (!_isLiquidityAllowed(sender, key, true)) {
            revert LiquidityNotAllowed(key.toId(), sender);
        }
    }

    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector) {
        selector = super._beforeRemoveLiquidity(sender, key, params, hookData);
        if (!_isLiquidityAllowed(sender, key, false)) {
            revert LiquidityNotAllowed(key.toId(), sender);
        }
    }
}
