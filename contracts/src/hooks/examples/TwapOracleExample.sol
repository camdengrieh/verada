// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {BaseHook} from "../base/BaseHook.sol";
import {TwapOracleHook} from "../oracle/TwapOracleHook.sol";

/// @title TwapOracleExample
/// @notice Deployable hook with only the TWAP oracle feature: checkpoints at least 5 minutes
///         apart, 24 kept per pool (windows up to about 2 hours at the busiest). Any pool, any
///         currencies, static or dynamic fee. Deploy at an address whose low 14 bits are exactly
///         `AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG` (mine it with `script/HookMiner.sol`).
contract TwapOracleExample is TwapOracleHook {
    constructor(IPoolManager manager) BaseHook(manager) TwapOracleHook(5 minutes, 24) {}
}
