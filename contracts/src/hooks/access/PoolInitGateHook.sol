// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {BaseHook} from "../base/BaseHook.sol";

/// @title PoolInitGateHook
/// @notice Restricts who may create pools that use this hook, plus an overridable rule on the
///         pool key itself (allowed quote currencies, one pool per token, a fixed fee or tick
///         spacing, a starting price band...).
/// @dev Contributes `beforeInitialize`. `sender` in `beforeInitialize` is the caller of
///      `PoolManager.initialize` (an EOA, a factory, or a router if one is used to initialize).
///      The allowlist is hook-level config set through the internal `_setPoolInitializer`; the
///      concrete hook chooses the access control that exposes it (see `PoolInitGateExample`).
///      With no initializer allowed, no pool can be created with this hook.
abstract contract PoolInitGateHook is BaseHook {
    /// @notice Accounts allowed to initialize pools with this hook (default rule).
    mapping(address account => bool) public isPoolInitializer;

    /// @notice `account` was allowed (`allowed == true`) or disallowed to initialize pools.
    event PoolInitializerSet(address indexed account, bool allowed);

    /// @notice `sender` called `PoolManager.initialize` but may not create pools with this hook.
    error InitializerNotAllowed(address sender);
    /// @notice The pool key (or starting price) breaks the concrete hook's pool key rule.
    error InvalidPoolKey();

    /// @dev Allows or disallows `account` as a pool initializer. The concrete hook exposes this
    ///      behind its own access control.
    function _setPoolInitializer(address account, bool allowed) internal {
        isPoolInitializer[account] = allowed;
        emit PoolInitializerSet(account, allowed);
    }

    /// @dev Whether `sender` (the caller of `PoolManager.initialize`) may create a pool. Defaults
    ///      to the `isPoolInitializer` allowlist; override for other rules (any contract deployed
    ///      by a factory, a role registry, permissionless...).
    function _isAllowedInitializer(address sender) internal view virtual returns (bool) {
        return isPoolInitializer[sender];
    }

    /// @dev Pool key rule, run after the initializer check. No-op by default. Override to revert
    ///      `InvalidPoolKey()` for keys the protocol does not accept (for example a quote
    ///      currency outside an allowed list). The rule is `view`: a stateful rule such as one
    ///      pool per token reads its state here and records it in the concrete hook's
    ///      `_beforeInitialize` override, after `super` (see docs/hooks/AccessGates.md).
    function _validatePoolKey(PoolKey calldata key, uint160 sqrtPriceX96) internal view virtual {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeInitialize = true;
        return p;
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override
        returns (bytes4 selector)
    {
        selector = super._beforeInitialize(sender, key, sqrtPriceX96);
        if (!_isAllowedInitializer(sender)) revert InitializerNotAllowed(sender);
        _validatePoolKey(key, sqrtPriceX96);
    }
}
