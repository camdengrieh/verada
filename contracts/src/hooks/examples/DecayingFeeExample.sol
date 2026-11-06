// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {BaseHook} from "../base/BaseHook.sol";
import {DecayingFeeHook} from "../fee/DecayingFeeHook.sol";

/// @title DecayingFeeExample
/// @notice Deployable hook with only the decaying LP fee. Whoever initializes a dynamic-fee pool
///         with it becomes the pool admin and sets the schedule with `setDecayingFee`.
/// @dev Address flags: `BEFORE_INITIALIZE_FLAG | BEFORE_SWAP_FLAG`.
contract DecayingFeeExample is DecayingFeeHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}
}
