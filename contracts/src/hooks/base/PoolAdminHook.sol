// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {BaseHook} from "./BaseHook.sol";

/// @title PoolAdminHook
/// @notice Per-pool admin shared by every configurable feature hook. When a pool is initialized
///         the hook records `_initialPoolAdmin(sender, key)` as its admin, where `sender` is the
///         caller of `PoolManager.initialize`. The admin can hand the role over or renounce it
///         (which freezes the pool's config).
/// @dev Contributes `beforeInitialize`. Features gate their config entry points with
///      `onlyPoolAdmin(key)`. `_initialPoolAdmin` has no default: a pool key is public and anyone
///      can call `PoolManager.initialize` first, so each concrete hook must choose who becomes
///      admin. Usual choices: compose `PoolInitGateHook` and return `sender` (only allowed
///      initializers get that far), or return a fixed account (an owner or a factory). Returning
///      `sender` with no gate lets anyone who initializes a key first take its admin role.
///      `_isPoolAdmin` can also be overridden (for example "only the factory").
abstract contract PoolAdminHook is BaseHook {
    /// @notice Admin of each pool (zero before initialization or after renouncing).
    mapping(PoolId => address) public poolAdmin;

    /// @notice The admin of `poolId` changed.
    event PoolAdminChanged(
        PoolId indexed poolId, address indexed previousAdmin, address indexed newAdmin
    );

    /// @notice The caller is not the admin of `poolId`.
    error NotPoolAdmin(PoolId poolId, address caller);

    modifier onlyPoolAdmin(PoolKey calldata key) {
        _checkPoolAdmin(key);
        _;
    }

    /// @notice Hands the admin role of `key`'s pool to `newAdmin` (zero renounces it).
    function transferPoolAdmin(PoolKey calldata key, address newAdmin) external onlyPoolAdmin(key) {
        PoolId id = key.toId();
        emit PoolAdminChanged(id, poolAdmin[id], newAdmin);
        poolAdmin[id] = newAdmin;
    }

    function _checkPoolAdmin(PoolKey calldata key) internal view {
        if (address(key.hooks) != address(this) || !_isPoolAdmin(key.toId(), msg.sender)) {
            revert NotPoolAdmin(key.toId(), msg.sender);
        }
    }

    /// @dev Whether `account` may configure `poolId`.
    function _isPoolAdmin(PoolId poolId, address account) internal view virtual returns (bool) {
        return account != address(0) && poolAdmin[poolId] == account;
    }

    /// @dev Admin recorded when a pool is initialized; `sender` is the caller of
    ///      `PoolManager.initialize`. Revert here to refuse the pool. No default (see the
    ///      contract notes): an ungated `return sender` lets a front-runner become admin.
    function _initialPoolAdmin(address sender, PoolKey calldata key)
        internal
        view
        virtual
        returns (address);

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
        address admin = _initialPoolAdmin(sender, key);
        PoolId id = key.toId();
        poolAdmin[id] = admin;
        emit PoolAdminChanged(id, address(0), admin);
    }
}
