// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator, IConsolidatorRegistry} from "./FeeConsolidator.sol";
import {V3SwapExecutor} from "./V3SwapExecutor.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {IUniswapV3Factory} from "./interfaces/external/IUniswapV3.sol";

/// @title FeeConsolidatorV3
/// @notice `FeeConsolidator` whose registry routes may also contain Uniswap v3 hops.
/// @dev A v3 hop is a registry `PoolKey` with tick spacing zero (`V3RouteLib`). Everything about
///      a hop except the swap itself is the shared v4 code: the same reference-tick deviation
///      guard (the reference table is keyed by the hop's key hash), the same minimum output
///      `max(spot, reference) * (1 - maxSlippageBps - hopFee)`, the same full-fill requirement,
///      the same in-swap bounds, and the same failure behaviour (a revert is caught by the caller,
///      the raw amount stays held).
///
///      The swap is a direct call to the factory's v3 pool, made by `V3SwapExecutor` (a small
///      contract this one deploys; it is the pool's swap callback and holds nothing between
///      calls), not through SwapRouter02 or the Universal Router: no router approval, no Permit2
///      and no extra contract in the trust path besides the executor. The output is measured here
///      from the balance difference.
///
///      There is no deadline argument: a conversion is never signed or queued, it executes
///      inside the transaction that triggers it, so `block.timestamp` is its deadline.
contract FeeConsolidatorV3 is FeeConsolidator {
    using SafeERC20 for IERC20;

    /// @notice The contract that swaps on v3 pools for this one (it holds the immutable v3 factory).
    V3SwapExecutor public immutable executor;

    constructor(
        address owner_,
        IPoolManager poolManager_,
        IConsolidatorRegistry quoteRegistry_,
        IFeeVault vault_,
        address weth_,
        uint256 maxSlippageBps_,
        uint256 maxDeviationTicks_,
        IUniswapV3Factory v3Factory_
    )
        FeeConsolidator(
            owner_, poolManager_, quoteRegistry_, vault_, weth_, maxSlippageBps_, maxDeviationTicks_
        )
    {
        if (address(v3Factory_) == address(0)) revert ZeroAddress();
        executor = new V3SwapExecutor(v3Factory_, address(this));
    }

    /// @inheritdoc FeeConsolidator
    function _v3Spot(PoolKey memory key)
        internal
        view
        override
        returns (uint160 sqrtPriceX96, int24 tick)
    {
        return executor.spot(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1), key.fee);
    }

    /// @inheritdoc FeeConsolidator
    function _v3Swap(PoolKey memory key, bool zeroForOne, uint256 amount)
        internal
        override
        returns (uint256 out)
    {
        address tokenIn = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        address tokenOut = Currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).safeTransfer(address(executor), amount);
        executor.swap(tokenIn, tokenOut, key.fee, amount);

        // Measured, not taken from the pool's report: the minimum output applies to what arrived.
        out = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
    }
}
