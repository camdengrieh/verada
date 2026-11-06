// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The asset a token's fees are consolidated into and its cause pool is kept in.
/// @dev `Usdc` is the original behaviour (value 0, the default). `Eth` is held on chain as WETH;
///      the donation itself always reaches Endaoment as USDC (converted at push time).
enum DonationAsset {
    Usdc,
    Eth
}
