// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";

contract PollScopeHarness {
    function decode(uint256 scope) external pure returns (uint8, uint64) {
        return PollScopeLib.decode(scope);
    }
}

contract PollScopeLibTest is Test {
    PollScopeHarness internal h = new PollScopeHarness();

    function testFuzz_roundTrip(bool rotation, uint64 id) public view {
        uint8 kind = rotation ? PollScopeLib.KIND_ROTATION : PollScopeLib.KIND_PERIOD;
        uint256 scope = PollScopeLib.encode(kind, id);
        (uint8 k, uint64 i) = h.decode(scope);
        assertEq(k, kind);
        assertEq(i, id);
    }

    function testFuzz_kindsAreDisjoint(uint64 a, uint64 b) public pure {
        assertTrue(
            PollScopeLib.encode(PollScopeLib.KIND_ROTATION, a)
                != PollScopeLib.encode(PollScopeLib.KIND_PERIOD, b)
        );
    }

    function testFuzz_invalidKindReverts(uint8 kind, uint64 id) public {
        vm.assume(kind != PollScopeLib.KIND_ROTATION && kind != PollScopeLib.KIND_PERIOD);
        uint256 scope = (uint256(kind) << 248) | id;
        vm.expectRevert(abi.encodeWithSelector(PollScopeLib.InvalidScope.selector, scope));
        h.decode(scope);
    }

    function testFuzz_dirtyMiddleBitsRevert(uint64 id, uint8 bit) public {
        uint256 b = bound(bit, 64, 247);
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, id) | (uint256(1) << b);
        vm.expectRevert(abi.encodeWithSelector(PollScopeLib.InvalidScope.selector, scope));
        h.decode(scope);
    }

    function test_plainEpochNumbersAreRejected() public {
        // A bare epoch-style scope (kind 0) can never be mistaken for one of this governor's polls.
        vm.expectRevert(abi.encodeWithSelector(PollScopeLib.InvalidScope.selector, 5));
        h.decode(5);
    }
}
