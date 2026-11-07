// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {IUniswapV3SwapCallback} from "../../src/interfaces/external/IUniswapV3.sol";

/// @dev Constant-price stand-in for a Uniswap v3 pool: pays `amountIn * (1 - fee) * price` out of
///      its own balance, then calls the swap callback and checks it was paid (as the real pool
///      does). Knobs make it misbehave: output shaved, partial fill, callback called twice.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    int24 public tick;
    /// @dev Output reduction in basis points (a bad price).
    uint256 public shaveBps;
    /// @dev Share of the input actually consumed, in basis points.
    uint256 public fillBps = 10_000;
    bool public callTwice;
    uint256 public swaps;

    constructor(address token0_, address token1_, uint24 fee_, int24 tick_) {
        require(token0_ < token1_, "order");
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        setTick(tick_);
    }

    function setTick(int24 tick_) public {
        tick = tick_;
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick_);
    }

    function setShave(uint256 bps) external {
        shaveBps = bps;
    }

    function setFill(uint256 bps) external {
        fillBps = bps;
    }

    function setCallTwice(bool v) external {
        callTwice = v;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick, 0, 0, 0, 0, true);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact in only");
        ++swaps;
        uint256 amountIn = (uint256(amountSpecified) * fillBps) / 10_000;
        uint256 afterFee = (amountIn * (1_000_000 - fee)) / 1_000_000;
        uint256 out = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(afterFee, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(afterFee, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
        out = (out * (10_000 - shaveBps)) / 10_000;

        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        IERC20(tokenOut).transfer(recipient, out);
        (amount0, amount1) = zeroForOne
            ? (int256(amountIn), -int256(out))
            : (-int256(out), int256(amountIn));

        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        if (callTwice) {
            IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        }
        require(IERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, "IIA");
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function create(address a, address b, uint24 fee, int24 tick) external returns (MockV3Pool pool) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pool = new MockV3Pool(t0, t1, fee, tick);
        getPool[t0][t1][fee] = address(pool);
        getPool[t1][t0][fee] = address(pool);
    }
}
