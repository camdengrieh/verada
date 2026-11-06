// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    IUniswapV3SwapCallback
} from "./interfaces/external/IUniswapV3.sol";

/// @title V3SwapExecutor
/// @notice Executes one exact-input swap on a Uniswap v3 pool for the fee consolidator, and is the
///         swap callback of that pool.
/// @dev Kept out of the consolidator so the consolidator's runtime stays under the contract size
///      limit and so the callback has a single, tiny trust boundary. Holds no funds between calls
///      and has no owner: only `consolidator` may call `swap`. The consolidator sends the input
///      here, `swap` pays the pool from it in the callback (the pool is the factory's pool of the
///      sorted pair and fee, nothing else), and the output goes straight to the consolidator.
///      The callback is authenticated by transient storage written only around the pool call: the
///      pool address and the input amount. It is cleared before paying, so a second callback in the
///      same swap pays nothing.
contract V3SwapExecutor is IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IUniswapV3Factory public immutable factory;
    address public immutable consolidator;

    /// @dev Transient slots of the callback context (fixed constants, used nowhere else).
    bytes32 private constant _POOL_SLOT =
        0x6d1a0d5ff7e85a1c3a3ed7f0c2b9f0a6f9d1d8e3b4ad6c7d3a95ed6f1b2c4a01;
    bytes32 private constant _TOKEN_SLOT =
        0x6d1a0d5ff7e85a1c3a3ed7f0c2b9f0a6f9d1d8e3b4ad6c7d3a95ed6f1b2c4a02;
    bytes32 private constant _AMOUNT_SLOT =
        0x6d1a0d5ff7e85a1c3a3ed7f0c2b9f0a6f9d1d8e3b4ad6c7d3a95ed6f1b2c4a03;

    error NotConsolidator();
    error V3PoolMissing(address token0, address token1, uint24 fee);
    error V3CallbackUnauthorized();
    /// @dev Same signature as `FeeConsolidator.PartialFill`, so callers see one selector.
    error PartialFill(uint256 spent, uint256 expected);

    constructor(IUniswapV3Factory factory_, address consolidator_) {
        factory = factory_;
        consolidator = consolidator_;
    }

    /// @notice The factory's pool of the sorted pair `(token0, token1)` and `fee`; reverts when the
    ///         shape is wrong or the pool does not exist.
    function poolOf(address token0, address token1, uint24 fee)
        public
        view
        returns (IUniswapV3Pool pool)
    {
        if (token0 == address(0) || token0 >= token1) revert V3PoolMissing(token0, token1, fee);
        pool = IUniswapV3Pool(factory.getPool(token0, token1, fee));
        if (address(pool) == address(0)) revert V3PoolMissing(token0, token1, fee);
    }

    /// @notice Spot of the pool of `(token0, token1, fee)`.
    function spot(address token0, address token1, uint24 fee)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick)
    {
        (sqrtPriceX96, tick,,,,,) = poolOf(token0, token1, fee).slot0();
    }

    /// @notice Swaps `amount` of `tokenIn` (already held here) for `tokenOut`, sending the output
    ///         to the consolidator. Reverts unless the whole amount is spent.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amount) external {
        if (msg.sender != consolidator) revert NotConsolidator();
        bool zeroForOne = tokenIn < tokenOut;
        IUniswapV3Pool pool =
            zeroForOne ? poolOf(tokenIn, tokenOut, fee) : poolOf(tokenOut, tokenIn, fee);

        _setContext(address(pool), tokenIn, amount);
        (int256 amount0, int256 amount1) = pool.swap(
            consolidator,
            zeroForOne,
            amount.toInt256(),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        _setContext(address(0), address(0), 0);

        int256 spent = zeroForOne ? amount0 : amount1;
        if (spent <= 0 || uint256(spent) != amount) {
            revert PartialFill(spent <= 0 ? 0 : uint256(spent), amount);
        }
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata)
        external
        override
    {
        (address pool, address tokenIn, uint256 expected) = _context();
        // Cleared first: a second callback in the same swap pays nothing.
        _setContext(address(0), address(0), 0);
        if (pool == address(0) || msg.sender != pool) revert V3CallbackUnauthorized();

        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        // A partial fill pays less than asked (`swap` then reports it). Never more.
        if (owed <= 0 || uint256(owed) > expected) revert V3CallbackUnauthorized();
        IERC20(tokenIn).safeTransfer(pool, uint256(owed));
    }

    function _setContext(address pool, address tokenIn, uint256 amount) private {
        bytes32 p = _POOL_SLOT;
        bytes32 t = _TOKEN_SLOT;
        bytes32 a = _AMOUNT_SLOT;
        assembly ("memory-safe") {
            tstore(p, pool)
            tstore(t, tokenIn)
            tstore(a, amount)
        }
    }

    function _context() private view returns (address pool, address tokenIn, uint256 amount) {
        bytes32 p = _POOL_SLOT;
        bytes32 t = _TOKEN_SLOT;
        bytes32 a = _AMOUNT_SLOT;
        assembly ("memory-safe") {
            pool := tload(p)
            tokenIn := tload(t)
            amount := tload(a)
        }
    }
}
