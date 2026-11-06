// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICuratorRegistry} from "../../src/interfaces/ICuratorRegistry.sol";

/// @dev Stand-in for the curator registry as the epoch governor reads it: `curationsFor` returns
///      whatever was set per bucket, for any epoch and version (count zero: no curation).
contract CurationsMock {
    mapping(uint16 bucket => ICuratorRegistry.Curation) internal _curations;

    function set(uint16 bucket, bytes32 picksRoot, uint8 count, uint16 weight, uint32 version)
        external
    {
        _curations[bucket] = ICuratorRegistry.Curation(picksRoot, count, weight, version);
    }

    function curationsFor(uint256, uint32, uint16[] calldata buckets)
        external
        view
        returns (ICuratorRegistry.Curation[] memory out)
    {
        out = new ICuratorRegistry.Curation[](buckets.length);
        for (uint256 i; i < buckets.length; ++i) {
            out[i] = _curations[buckets[i]];
        }
    }
}
