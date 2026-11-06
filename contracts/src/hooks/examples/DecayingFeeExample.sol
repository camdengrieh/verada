// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {DecayingFeeHook} from "../fee/DecayingFeeHook.sol";

/// @title DecayingFeeExample
/// @notice Deployable hook with the decaying LP fee. Only initializers the owner allows may
///         create pools (`PoolInitGateHook`); the initializer of a dynamic-fee pool becomes its
///         admin and sets the schedule with `setDecayingFee`.
/// @dev Address flags: `BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG`.
contract DecayingFeeExample is PoolInitGateHook, DecayingFeeHook, Ownable {
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
        override(PoolInitGateHook, DecayingFeeHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override(PoolInitGateHook, DecayingFeeHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        internal
        virtual
        override(BaseHook, DecayingFeeHook)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(sender, key, params, hookData);
    }
}
