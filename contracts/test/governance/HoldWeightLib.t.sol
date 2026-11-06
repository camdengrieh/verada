// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {VaradaToken} from "../../src/VaradaToken.sol";
import {HoldWeightLib} from "../../src/libraries/HoldWeightLib.sol";

contract HoldWeightHarness {
    mapping(bytes32 => HoldWeightLib.Scan) internal _scans;

    function lowest(address token, address account, uint256 holdFrom, uint256 snapshot)
        external
        view
        returns (uint64)
    {
        return HoldWeightLib.lowest(_scans, token, account, holdFrom, snapshot);
    }

    function advance(
        address token,
        address account,
        uint256 holdFrom,
        uint256 snapshot,
        uint256 maxReads
    ) external returns (bool) {
        return HoldWeightLib.advance(_scans, token, account, holdFrom, snapshot, maxReads);
    }
}

/// @notice The shared hold weight: the lowest checkpoint over the whole window, no scan cap, and
///         a scan that can be run ahead in chunks so dust checkpoints cannot block a ballot.
contract HoldWeightLibTest is Test {
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant WHOLE = 1e18;

    HoldWeightHarness internal h;
    VaradaToken internal token;
    address internal factory = makeAddr("factory");
    address internal holder = makeAddr("holder");
    address internal other = makeAddr("other");
    address internal griefer = makeAddr("griefer");

    function setUp() public {
        vm.warp(T0);
        h = new HoldWeightHarness();
        token = new VaradaToken("Varada Test", "VTEST", "ipfs://meta", makeAddr("c"), factory);
        vm.prank(factory);
        token.transfer(holder, 1000 * WHOLE);
        vm.prank(factory);
        token.transfer(griefer, 1000 * WHOLE);
    }

    function _send(address from, address to, uint256 amount, uint256 at) internal {
        vm.warp(at);
        vm.prank(from);
        token.transfer(to, amount);
    }

    /// @dev Dust from a third party at `n` distinct seconds starting at `from`.
    function _dust(uint256 n, uint256 from) internal {
        for (uint256 i; i < n; ++i) {
            _send(griefer, holder, 1, from + i);
        }
    }

    function test_lowest_isTheLowestCheckpointInTheWindow() public {
        _send(holder, other, 300 * WHOLE, T0 + 100); // 700
        _send(holder, other, 500 * WHOLE, T0 + 200); // 200
        _send(other, holder, 800 * WHOLE, T0 + 300); // 1000
        vm.warp(T0 + 1000);
        assertEq(h.lowest(address(token), holder, T0 + 50, T0 + 900), 200);
        // Starting the window after the dip.
        assertEq(h.lowest(address(token), holder, T0 + 300, T0 + 900), 1000);
        // The checkpoint in effect at the window's start counts.
        assertEq(h.lowest(address(token), holder, T0 + 250, T0 + 900), 200);
        // A window start at or after the snapshot reads the snapshot alone.
        assertEq(h.lowest(address(token), holder, T0 + 900, T0 + 900), 1000);
        // No votes at the window's start: zero.
        assertEq(h.lowest(address(token), other, T0 + 50, T0 + 900), 0);
        // The snapshot must be in the past.
        assertEq(h.lowest(address(token), holder, T0, T0 + 1000), 0);
    }

    /// Audit #1: a sale and buy-back mid-window, hidden behind 200 later checkpoints, still
    /// gives zero (the old scan stopped after 128 checkpoints).
    function test_dipHiddenBehindManyCheckpoints_isFound() public {
        _send(holder, other, 1000 * WHOLE, T0 + 100);
        _send(other, holder, 1000 * WHOLE, T0 + 101);
        _dust(200, T0 + 102);
        vm.warp(T0 + 1000);
        assertEq(token.numCheckpoints(holder), 203);
        assertEq(h.lowest(address(token), holder, T0 + 1, T0 + 999), 0);
        // Before the dip the window still counts in full.
        assertEq(h.lowest(address(token), holder, T0 + 1, T0 + 99), 1000);
    }

    /// Dust a third party sends never lowers a weight; it only adds reads.
    function test_dust_neverLowersTheWeight() public {
        _dust(300, T0 + 100);
        vm.warp(T0 + 1000);
        assertEq(h.lowest(address(token), holder, T0 + 1, T0 + 999), 1000);
    }

    /// A scan run ahead in chunks gives the same weight, and the ballot afterwards reads only
    /// what is left: dust can make a holder pay for reads, never block the ballot.
    function test_advance_inChunks_matchesAndCaches() public {
        _send(holder, other, 400 * WHOLE, T0 + 50); // 600 before the dust
        _dust(1000, T0 + 100);
        vm.warp(T0 + 5000);
        uint256 from = T0 + 10;
        uint256 snap = T0 + 4000;

        uint256 g = gasleft();
        assertEq(h.lowest(address(token), holder, from, snap), 600);
        uint256 full = g - gasleft();

        assertFalse(h.advance(address(token), holder, from, snap, 400));
        assertFalse(h.advance(address(token), holder, from, snap, 400));
        assertEq(h.lowest(address(token), holder, from, snap), 600, "partial cache resumes");
        assertTrue(h.advance(address(token), holder, from, snap, 400));
        // Done stays done.
        assertTrue(h.advance(address(token), holder, from, snap, 0));

        g = gasleft();
        assertEq(h.lowest(address(token), holder, from, snap), 600);
        uint256 cached = g - gasleft();
        assertLt(cached, 20_000, "one cached slot");
        assertGt(full, 1000 * 1000, "the uncached read pays per checkpoint");
    }

    /// Cost of one checkpoint read with cold storage, the case on chain: under 5k gas, so a
    /// block of 60M gas reads over 10k of them, and a chunked `advance` reads any number.
    function test_scan_costPerColdCheckpoint() public {
        _dust(1000, T0 + 100);
        vm.warp(T0 + 5000);
        vm.cool(address(token));
        vm.cool(address(h));
        uint256 g = gasleft();
        assertTrue(h.advance(address(token), holder, T0 + 10, T0 + 4000, 2000));
        uint256 used = g - gasleft();
        emit log_named_uint("gas per checkpoint", used / 1001);
        assertLt(used, 1001 * 5000);
        assertGt(used, 1001 * 3000);
    }

    /// Progress is cached per window: another window is not affected.
    function test_advance_isPerWindow() public {
        _send(holder, other, 1000 * WHOLE, T0 + 100);
        _send(other, holder, 1000 * WHOLE, T0 + 200);
        vm.warp(T0 + 1000);
        assertTrue(h.advance(address(token), holder, T0 + 150, T0 + 900, 10));
        assertEq(h.lowest(address(token), holder, T0 + 150, T0 + 900), 0);
        assertEq(h.lowest(address(token), holder, T0 + 200, T0 + 900), 1000);
        assertEq(h.lowest(address(token), other, T0 + 150, T0 + 900), 0);
    }

    /// A window that has not ended can still change, so it is never cached.
    function test_advance_revertsWhileTheWindowIsOpen() public {
        vm.expectRevert(abi.encodeWithSelector(HoldWeightLib.HoldWindowOpen.selector, T0));
        h.advance(address(token), holder, T0 - 10, T0, 10);
    }

    /// The weight equals the lowest of the votes at the window's start and at every checkpoint
    /// inside it, whatever chunk size the scan was run ahead with.
    function testFuzz_lowest_matchesBruteForce(
        uint8[24] calldata gaps,
        uint16[24] calldata amounts,
        bool[24] calldata outgoing,
        uint16 fromOffset,
        uint16 snapOffset,
        uint8 chunk
    ) public {
        uint256 t = T0;
        for (uint256 i; i < 24; ++i) {
            t += uint256(gaps[i]) + 1;
            if (outgoing[i]) {
                uint256 bal = token.balanceOf(holder);
                _send(holder, other, bal == 0 ? 0 : uint256(amounts[i]) % (bal / WHOLE + 1) * WHOLE, t);
            } else {
                _send(griefer, holder, uint256(amounts[i]) % 50 * WHOLE, t);
            }
        }
        vm.warp(t + 1);
        uint256 snap = T0 + uint256(snapOffset) % (t - T0 + 1);
        uint256 from = T0 + uint256(fromOffset) % (t - T0 + 1);

        uint256 expected = token.getPastVotes(holder, from < snap ? from : snap);
        for (uint32 i; i < token.numCheckpoints(holder); ++i) {
            VaradaToken.Checkpoint memory c = token.checkpoints(holder, i);
            if (c.key > from && c.key <= snap && c.value < expected) expected = c.value;
        }
        expected /= WHOLE;

        assertEq(h.lowest(address(token), holder, from, snap), expected);
        while (!h.advance(address(token), holder, from, snap, uint256(chunk) % 4 + 1)) {}
        assertEq(h.lowest(address(token), holder, from, snap), expected, "after chunks");
    }
}
