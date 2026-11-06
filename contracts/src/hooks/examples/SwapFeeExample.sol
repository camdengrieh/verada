// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {PoolAdminHook} from "../base/PoolAdminHook.sol";
import {SwapFeeHook} from "../fee/SwapFeeHook.sol";

/// @title SwapFeeExample
/// @notice Deployable swap fee hook: a per-pool swap fee in basis points, paid to a per-pool
///         recipient as ERC-6909 claims or tokens. Only initializers the owner allows may create
///         pools (`PoolInitGateHook`); the initializer becomes the pool admin and configures the
///         fee with `setSwapFee`.
/// @dev Deploy at an address whose low bits encode exactly `beforeInitialize`, `afterSwap` and
///      `afterSwapReturnDelta` (mine it with `script/HookMiner.sol`).
contract SwapFeeExample is PoolInitGateHook, SwapFeeHook, Ownable {
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
        override(PoolInitGateHook, SwapFeeHook)
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

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal virtual override(BaseHook, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}
