// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

/// @title V3RouteLib
/// @notice Encoding of a Uniswap v3 pool as a route hop, without changing the `PoolKey[]` shape of
///         registry routes.
/// @dev A v3 hop is a `PoolKey` with `tickSpacing == 0`, `hooks == address(0)`, `currency0 <
///      currency1` (both ERC-20, never native ETH) and `fee` one of the four v3 tiers. Uniswap v4
///      rejects a tick spacing of zero, so no real v4 pool can collide with the encoding, and the
///      pool id (`keccak256(abi.encode(key))`) of a v3 hop is only ever used as the key of the
///      consolidator's reference table.
library V3RouteLib {
    /// @dev The marker: no v4 pool has this tick spacing.
    int24 internal constant TICK_SPACING = 0;

    /// @notice Whether `key` encodes a v3 hop (shape marker only; see `isValidV3`).
    function isV3(PoolKey memory key) internal pure returns (bool) {
        return key.tickSpacing == TICK_SPACING;
    }

    /// @notice Whether `fee` is one of the four Uniswap v3 fee tiers.
    function isFeeTier(uint24 fee) internal pure returns (bool) {
        return fee == 100 || fee == 500 || fee == 3000 || fee == 10_000;
    }

    /// @notice Whether `key` is a well formed v3 hop: marker, no hooks, sorted ERC-20 pair, tier.
    function isValidV3(PoolKey memory key) internal pure returns (bool) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        return key.tickSpacing == TICK_SPACING && address(key.hooks) == address(0)
            && c0 != address(0) && c0 < c1 && isFeeTier(key.fee);
    }

    /// @notice The hop for the v3 pool of `(a, b, fee)` (the order of `a` and `b` does not matter).
    function hop(address a, address b, uint24 fee) internal pure returns (PoolKey memory key) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, TICK_SPACING, IHooks(address(0)));
    }
}
