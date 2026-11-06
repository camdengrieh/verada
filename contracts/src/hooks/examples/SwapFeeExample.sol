// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {BaseHook} from "../base/BaseHook.sol";
import {SwapFeeHook} from "../fee/SwapFeeHook.sol";

/// @title SwapFeeExample
/// @notice Deployable single-feature hook: a per-pool swap fee in basis points, paid to a
///         per-pool recipient as ERC-6909 claims or tokens. The caller of
///         `PoolManager.initialize` becomes the pool admin and configures the fee with
///         `setSwapFee`.
/// @dev Deploy at an address whose low bits encode exactly `beforeInitialize`, `afterSwap` and
///      `afterSwapReturnDelta` (mine it with `script/HookMiner.sol`).
contract SwapFeeExample is SwapFeeHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}
}
