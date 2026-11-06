// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IV3PoolSwapper
/// @notice Exact-input swaps through the pools of an allowlisted Uniswap v3-style factory,
///         without the Universal Router.
interface IV3PoolSwapper {
    event Swapped(
        address indexed payer,
        address indexed pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error ZeroAddress();
    error LengthMismatch();
    error FactoryNotAllowed(address factory);
    error DeadlinePassed(uint256 deadline);
    error InvalidPair();
    error InvalidRecipient();
    error ZeroAmount();
    error PoolMissing(address pool);
    error NotThePool(address caller);
    error NotSwapping();
    error Reentered();
    error OwedTooMuch(uint256 owed, uint256 amountIn);
    error TooLittleReceived(uint256 received, uint256 minOut);
    error AmountTooLarge();

    /// @notice Whether `factory` is on the allowlist fixed at deployment.
    function isAllowedFactory(address factory) external view returns (bool);

    /// @notice The pool of (`tokenA`, `tokenB`, `fee`) in `factory`, derived from its init code
    ///         hash. It need not exist yet; `swapExactIn` checks that code is deployed there.
    function poolOf(address factory, address tokenA, address tokenB, uint24 fee)
        external
        view
        returns (address);

    /// @notice Swaps up to `amountIn` of `tokenIn` for `tokenOut` through the pool of `factory`
    ///         at `fee`, taking the input from the caller (who must have approved this contract)
    ///         and sending the output straight to `recipient`.
    /// @param sqrtPriceLimitX96 Price limit; zero means the widest limit in the swap direction.
    ///        When the limit is hit first, only part of `amountIn` is spent (and pulled).
    /// @param minOut Minimum balance increase of `recipient`, measured, not self-reported.
    /// @param deadline Last timestamp at which the swap may execute.
    /// @return spent Input actually pulled from the caller.
    /// @return received Output actually received by `recipient`.
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
    ) external returns (uint256 spent, uint256 received);
}
