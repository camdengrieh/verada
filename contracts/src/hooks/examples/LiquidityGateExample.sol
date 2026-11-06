// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {LiquidityGateHook} from "../access/LiquidityGateHook.sol";
import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {PoolAdminHook} from "../base/PoolAdminHook.sol";

/// @title LiquidityGateExample
/// @notice Deployable `LiquidityGateHook`: only initializers the owner allows may create pools
///         (`PoolInitGateHook`), and the initializer becomes the pool admin. The admin may gate
///         adding and/or removing liquidity to an allowlist of senders, then hand the role over
///         or renounce it. Address flags: `beforeInitialize`, `beforeAddLiquidity`,
///         `beforeRemoveLiquidity`.
contract LiquidityGateExample is PoolInitGateHook, LiquidityGateHook, Ownable {
    /// @param poolManager_ The v4 pool manager.
    /// @param owner_ The account that may allow and disallow pool initializers.
    constructor(IPoolManager poolManager_, address owner_) BaseHook(poolManager_) Ownable(owner_) {}

    /// @notice Allows or disallows `account` to initialize pools with this hook. Only the owner.
    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    /// @dev The caller of `PoolManager.initialize` passed the init gate, so it is the admin.
    function _initialPoolAdmin(address sender, PoolKey calldata)
        internal
        view
        virtual
        override
        returns (address)
    {
        return sender;
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override(PoolInitGateHook, LiquidityGateHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override(PoolInitGateHook, PoolAdminHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal virtual override(BaseHook, LiquidityGateHook) returns (bytes4) {
        return super._beforeAddLiquidity(sender, key, params, hookData);
    }

    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal virtual override(BaseHook, LiquidityGateHook) returns (bytes4) {
        return super._beforeRemoveLiquidity(sender, key, params, hookData);
    }
}
