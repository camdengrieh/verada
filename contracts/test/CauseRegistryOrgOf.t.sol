// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";

/// @dev `CauseRegistry.orgOf`: the org id and address without the metadata string.
contract CauseRegistryOrgOfTest is Test {
    CauseRegistry internal registry;
    MockOrgFactory internal factory;

    function setUp() public {
        MockUSDC usdc = new MockUSDC();
        factory = new MockOrgFactory(new MockEndaomentRegistry(address(usdc), address(1)));
        registry = new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(factory)));
    }

    function testFuzz_orgOf_matchesGetCause(bytes32 id, bytes32 orgId) public {
        vm.assume(orgId != bytes32(0));
        address org = factory.computeOrgAddress(orgId);
        registry.addCause(id, orgId, org, "ipfs://a-long-metadata-uri");
        (bytes32 gotId, address gotOrg) = registry.orgOf(id);
        ICauseRegistry.Cause memory c = registry.getCause(id);
        assertEq(gotId, c.orgId);
        assertEq(gotOrg, c.orgAddress);
        assertEq(gotOrg, org);
    }

    function test_orgOf_deactivatedStillResolves() public {
        bytes32 orgId = bytes32("123");
        registry.addCause(keccak256("x"), orgId, factory.computeOrgAddress(orgId), "");
        registry.deactivateCause(keccak256("x"));
        (bytes32 gotId,) = registry.orgOf(keccak256("x"));
        assertEq(gotId, orgId);
    }

    function test_orgOf_unknownReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ICauseRegistry.CauseNotFound.selector, bytes32("no"))
        );
        registry.orgOf(bytes32("no"));
    }
}
