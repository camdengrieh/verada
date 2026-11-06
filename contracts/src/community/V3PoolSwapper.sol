// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IV3PoolSwapper} from "../interfaces/IV3PoolSwapper.sol";

interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title V3PoolSwapper
/// @notice Swaps through the pools of Uniswap v3-style factories the Universal Router cannot
///         reach (it hard-codes the canonical factory). Used by the fee consolidator for V3 hops
///         and by the web swap flow for a router-less path.
/// @dev Trust model.
///      - Factories and their init code hashes are fixed in the constructor. There is no owner
///        and no setter, so this contract has no admin surface; widening the set means deploying
///        a new swapper and pointing the consolidator at it. The consolidator's routes are
///        already owner-managed (QuoteRegistry), so that owner is the only party that picks which
///        (factory, fee tier) a fee conversion touches.
///      - A pool is accepted only if it is the CREATE2 address of (factory, token0, token1, fee)
///        and has code. With a verified init code hash that is plain UniswapV3Pool code deployed
///        by an allowlisted factory. The factory's operator can still create and seed pools
///        (deceptive prices, thin liquidity), which is why callers must name the exact fee tier,
///        set `minOut` from their own reference, and not let a third party choose the pool.
///      - The callback is honoured only while a swap started by this contract is in flight and
///        only from the pool that swap targeted (transient storage). It pays exactly the owed
///        input from the payer recorded at swap start, never more than `amountIn`, and only the
///        input token. The payer is always the caller of `swapExactIn`, so a third party cannot
///        spend someone else's approval.
///      - The contract never holds tokens: input moves payer to pool, output pool to recipient.
///        Tokens sent to it by mistake are not recoverable (no rescue path by design).
contract V3PoolSwapper is IV3PoolSwapper {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @dev Init code hash per allowed factory; zero means not allowed.
    mapping(address factory => bytes32 initCodeHash) private _initCodeHash;

    // Transient slots of the swap in flight.
    bytes32 private constant _POOL_SLOT = keccak256("verada.v3PoolSwapper.pool");
    bytes32 private constant _PAYER_SLOT = keccak256("verada.v3PoolSwapper.payer");
    bytes32 private constant _TOKEN_SLOT = keccak256("verada.v3PoolSwapper.token");
    bytes32 private constant _CAP_SLOT = keccak256("verada.v3PoolSwapper.cap");

    constructor(address[] memory factories, bytes32[] memory initCodeHashes) {
        if (factories.length != initCodeHashes.length) revert LengthMismatch();
        for (uint256 i; i < factories.length; ++i) {
            if (factories[i] == address(0) || initCodeHashes[i] == bytes32(0)) revert ZeroAddress();
            _initCodeHash[factories[i]] = initCodeHashes[i];
        }
    }

    /// @inheritdoc IV3PoolSwapper
    function isAllowedFactory(address factory) external view returns (bool) {
        return _initCodeHash[factory] != bytes32(0);
    }

    /// @inheritdoc IV3PoolSwapper
    function poolOf(address factory, address tokenA, address tokenB, uint24 fee)
        public
        view
        returns (address)
    {
        bytes32 hash = _initCodeHash[factory];
        if (hash == bytes32(0)) revert FactoryNotAllowed(factory);
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", factory, keccak256(abi.encode(t0, t1, fee)), hash)
                    )
                )
            )
        );
    }

    /// @inheritdoc IV3PoolSwapper
    function swapExactIn(
        address factory,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        uint160 sqrtPriceLimitX96,
        address recipient,
        uint256 deadline
    ) external returns (uint256 spent, uint256 received) {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();
        if (tokenIn == tokenOut || tokenIn == address(0) || tokenOut == address(0)) {
            revert InvalidPair();
        }
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        address pool = poolOf(factory, tokenIn, tokenOut, fee);
        if (pool.code.length == 0) revert PoolMissing(pool);

        bool zeroForOne = tokenIn < tokenOut;
        if (sqrtPriceLimitX96 == 0) {
            sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        }

        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);
        uint256 inBefore = IERC20(tokenIn).balanceOf(msg.sender);

        _setSwap(pool, msg.sender, tokenIn, amountIn);
        IUniswapV3PoolSwap(pool).swap(recipient, zeroForOne, int256(amountIn), sqrtPriceLimitX96, "");
        _clearSwap();

        received = IERC20(tokenOut).balanceOf(recipient) - outBefore;
        spent = inBefore - IERC20(tokenIn).balanceOf(msg.sender);
        if (received < minOut) revert TooLittleReceived(received, minOut);
        emit Swapped(msg.sender, pool, tokenIn, tokenOut, spent, received);
    }

    /// @notice Uniswap v3 swap callback. Pays the owed input; reverts for everyone but the pool
    ///         of the swap in flight.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata)
        external
    {
        address pool;
        address payer;
        address token;
        uint256 cap;
        bytes32 poolSlot = _POOL_SLOT;
        bytes32 payerSlot = _PAYER_SLOT;
        bytes32 tokenSlot = _TOKEN_SLOT;
        bytes32 capSlot = _CAP_SLOT;
        assembly {
            pool := tload(poolSlot)
            payer := tload(payerSlot)
            token := tload(tokenSlot)
            cap := tload(capSlot)
        }
        if (pool == address(0)) revert NotSwapping();
        if (msg.sender != pool) revert NotThePool(msg.sender);

        // For an exact-input swap exactly one delta is positive: the input owed to the pool.
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owedSigned <= 0) return;
        uint256 owed = uint256(owedSigned);
        if (owed > cap) revert OwedTooMuch(owed, cap);

        // The whole swap may pull at most `amountIn`, however often the pool calls back.
        bytes32 slot = _CAP_SLOT;
        uint256 left = cap - owed;
        assembly {
            tstore(slot, left)
        }
        IERC20(token).safeTransferFrom(payer, pool, owed);
    }

    function _setSwap(address pool, address payer, address token, uint256 cap) private {
        bytes32 poolSlot = _POOL_SLOT;
        bytes32 payerSlot = _PAYER_SLOT;
        bytes32 tokenSlot = _TOKEN_SLOT;
        bytes32 capSlot = _CAP_SLOT;
        uint256 active;
        assembly {
            active := tload(poolSlot)
        }
        if (active != 0) revert Reentered();
        assembly {
            tstore(poolSlot, pool)
            tstore(payerSlot, payer)
            tstore(tokenSlot, token)
            tstore(capSlot, cap)
        }
    }

    function _clearSwap() private {
        bytes32 poolSlot = _POOL_SLOT;
        assembly {
            tstore(poolSlot, 0)
        }
    }
}
