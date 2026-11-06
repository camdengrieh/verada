// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {LiquidityGateHook} from "../access/LiquidityGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";

/// @title LiquidityGateExample
/// @notice Deployable `LiquidityGateHook`: anyone may create a pool and becomes its admin; the
///         admin may gate adding and/or removing liquidity to an allowlist of senders, then hand
///         the role over or renounce it. Address flags: `beforeInitialize`,
///         `beforeAddLiquidity`, `beforeRemoveLiquidity`.
contract LiquidityGateExample is LiquidityGateHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}
}
