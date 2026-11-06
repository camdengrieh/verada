// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";

/// @title PoolInitGateExample
/// @notice Deployable `PoolInitGateHook`: only accounts the owner allows may create pools with
///         this hook. No pool key rule. Address flags: `beforeInitialize`.
contract PoolInitGateExample is PoolInitGateHook, Ownable {
    constructor(IPoolManager poolManager_, address owner_) BaseHook(poolManager_) Ownable(owner_) {}

    /// @notice Allows or disallows `account` to initialize pools with this hook. Owner only.
    /// @param account The caller of `PoolManager.initialize` (an EOA or a factory contract).
    /// @param allowed Whether `account` may create pools.
    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }
}
