// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {PoolInitGateHook} from "../../../src/hooks/access/PoolInitGateHook.sol";

/// @notice Shared test base for `src/hooks`: the real v4 PoolManager and routers (Deployers),
///         plus deployment of a hook at an address that encodes a given flag set.
abstract contract HookTest is Deployers {
    /// @dev The 14 permission bits of a hook address.
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1);

    uint256 private _hookSalt;

    /// @notice A fresh address whose low 14 bits are exactly `flags`.
    function _hookAddress(uint160 flags) internal returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("hook", ++_hookSalt))));
        return address((high & ~ALL_HOOK_MASK) | (flags & ALL_HOOK_MASK));
    }

    /// @notice Flag bits of a permission set.
    function _flags(Hooks.Permissions memory p) internal pure returns (uint160 f) {
        if (p.beforeInitialize) f |= Hooks.BEFORE_INITIALIZE_FLAG;
        if (p.afterInitialize) f |= Hooks.AFTER_INITIALIZE_FLAG;
        if (p.beforeAddLiquidity) f |= Hooks.BEFORE_ADD_LIQUIDITY_FLAG;
        if (p.afterAddLiquidity) f |= Hooks.AFTER_ADD_LIQUIDITY_FLAG;
        if (p.beforeRemoveLiquidity) f |= Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        if (p.afterRemoveLiquidity) f |= Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        if (p.beforeSwap) f |= Hooks.BEFORE_SWAP_FLAG;
        if (p.afterSwap) f |= Hooks.AFTER_SWAP_FLAG;
        if (p.beforeDonate) f |= Hooks.BEFORE_DONATE_FLAG;
        if (p.afterDonate) f |= Hooks.AFTER_DONATE_FLAG;
        if (p.beforeSwapReturnDelta) f |= Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterSwapReturnDelta) f |= Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterAddLiquidityReturnDelta) f |= Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        if (p.afterRemoveLiquidityReturnDelta) {
            f |= Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;
        }
    }

    /// @notice Deploys artifact `what` ("File.sol:Contract") with `args` at a fresh address
    ///         encoding `flags` (the constructor runs at that address, so the base's address
    ///         check passes).
    function _deployHook(string memory what, bytes memory args, uint160 flags)
        internal
        returns (address hook)
    {
        hook = _hookAddress(flags);
        deployCodeTo(what, args, hook);
    }

    /// @notice Revert data of `PoolManager.initialize` when `hook`'s init gate refuses `sender`.
    function _initGateRevert(address hook, address sender) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hook,
            IHooks.beforeInitialize.selector,
            abi.encodeWithSelector(PoolInitGateHook.InitializerNotAllowed.selector, sender),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }
}
