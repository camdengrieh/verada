// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {LiquidityGateHook} from "../access/LiquidityGateHook.sol";
import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {PoolAdminHook} from "../base/PoolAdminHook.sol";
import {DecayingFeeHook} from "../fee/DecayingFeeHook.sol";
import {SwapFeeHook} from "../fee/SwapFeeHook.sol";
import {TwapOracleHook} from "../oracle/TwapOracleHook.sol";

/// @title LaunchpadHook
/// @notice A generic token-launch hook built only from the feature hooks in `src/hooks`:
///         - `PoolInitGateHook`: only initializers the owner allows (a launch factory) may create
///           pools with this hook; the initializer becomes the pool admin.
///         - `LiquidityGateHook`: the pool admin can restrict who adds and removes liquidity, so
///           launch liquidity can be placed by a locker and then locked by renouncing.
///         - `TwapOracleHook`: a time-weighted average tick per pool (5 minute checkpoints, 24 of
///           them), readable through `twapTick`.
///         - `DecayingFeeHook`: a launch LP fee that starts high and decays to a base fee.
///         - `SwapFeeHook`: a hook fee on the unspecified side of every swap, paid to a per-pool
///           recipient as tokens or ERC-6909 claims.
///         Usable as is by any launchpad or LP; a protocol adds its own rules by overriding the
///         features' hooks (`_isPoolAdmin`, `_validatePoolKey`, `_swapFeeBps`, `_onSwapFeeTaken`).
/// @dev The worked example of the composition rule (docs/hooks/Composition.md). Every internal
///      function that two or more bases define is re-declared below, listing every base whose
///      definition is still open in `override(...)`, with a body that only calls `super`
///      (rule 6), so the C3 linearization runs each feature exactly once, in inheritance list
///      order. Pay the hook fee as claims (`asClaims = true`) for launches: token settlement of
///      an exact-output buy needs the pool manager to already hold the input currency.
///
///      Typical launch, all in one factory transaction:
///       1. owner: `setPoolInitializer(factory, true)` (once).
///       2. factory: `PoolManager.initialize(key, sqrtPrice)` with a dynamic-fee key
///          (`LPFeeLibrary.DYNAMIC_FEE_FLAG`); the factory becomes the pool admin.
///       3. factory: `setDecayingFee`, `setSwapFee`, `setLiquidityGate(key, true, true)`,
///          `setLiquidityProvider(key, locker, true)`.
///       4. locker: adds the single-sided launch position (the locker has no removal path).
///       5. factory: `transferPoolAdmin(key, address(0))` freezes the pool's config for good.
contract LaunchpadHook is
    PoolInitGateHook,
    LiquidityGateHook,
    TwapOracleHook,
    DecayingFeeHook,
    SwapFeeHook,
    Ownable
{
    /// @param manager The Uniswap v4 pool manager.
    /// @param owner_ The account that may allow and disallow pool initializers.
    constructor(IPoolManager manager, address owner_)
        BaseHook(manager)
        TwapOracleHook(5 minutes, 24)
        Ownable(owner_)
    {}

    /// @notice Allows or disallows `account` to initialize pools with this hook.
    /// @dev Only the owner. Disallowing does not affect pools already created.
    /// @param account The initializer (normally a launch factory).
    /// @param allowed Whether `account` may call `PoolManager.initialize` for this hook.
    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    // ------------------------------------------------------------------ rule 6 boilerplate

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override(PoolInitGateHook, LiquidityGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override(BaseHook, PoolAdminHook, PoolInitGateHook, DecayingFeeHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) internal virtual override(BaseHook, TwapOracleHook) returns (bytes4) {
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
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
