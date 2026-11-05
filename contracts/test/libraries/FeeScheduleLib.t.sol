// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {FeeScheduleLib} from "../../src/libraries/FeeScheduleLib.sol";

/// @dev External wrapper so library reverts can be asserted.
contract FeeScheduleHarness {
    function validate(uint24 baseBps, uint24 startBps, uint32 decaySeconds) external pure {
        FeeScheduleLib.validate(baseBps, startBps, decaySeconds);
    }
}

contract FeeScheduleLibTest is Test {
    FeeScheduleHarness internal h;
    uint160 internal constant WEEKLY_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function setUp() public {
        h = new FeeScheduleHarness();
        vm.warp(1_700_000_000);
    }

    function test_bounds() public {
        h.validate(100, 0, 0);
        h.validate(500, 8000, 1 days);
        h.validate(300, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(FeeScheduleLib.InvalidFee.selector, 99));
        h.validate(99, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(FeeScheduleLib.InvalidFee.selector, 501));
        h.validate(501, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 8001, 10)
        );
        h.validate(300, 8001, 10);
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 1, 0)
        );
        h.validate(300, 1, 0);
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 1, 86_401)
        );
        h.validate(300, 1, 86_401);
    }

    function test_invalidFeeSelectorMatchesWeeklyHook() public pure {
        assertEq(FeeScheduleLib.InvalidFee.selector, bytes4(keccak256("InvalidFee(uint24)")));
    }

    function test_surcharge_shape() public pure {
        assertEq(FeeScheduleLib.surchargeBps(0, 100, 10, 50), 0);
        assertEq(FeeScheduleLib.surchargeBps(1000, 0, 10, 50), 0);
        assertEq(FeeScheduleLib.surchargeBps(1000, 100, 10, 5), 1000, "before launch");
        assertEq(FeeScheduleLib.surchargeBps(1000, 100, 10, 10), 1000, "at launch");
        assertEq(FeeScheduleLib.surchargeBps(1000, 100, 10, 60), 500, "half way");
        assertEq(FeeScheduleLib.surchargeBps(1000, 100, 10, 109), 10, "rounded up");
        assertEq(FeeScheduleLib.surchargeBps(1000, 100, 10, 110), 0, "decayed");
        assertEq(FeeScheduleLib.surchargeBps(7, 3, 0, 1), 5, "ceil(7 * 2 / 3)");
    }

    function test_totalBps_atMost8500() public pure {
        IVeradaLiveHook.LiveFeeConfig memory c = IVeradaLiveHook.LiveFeeConfig(500, 8000, 60, 100);
        assertEq(FeeScheduleLib.totalBps(c, 100), 8500);
        assertEq(FeeScheduleLib.totalBps(c, 160), 500);
    }

    function test_feeRoundsUp() public pure {
        assertEq(FeeScheduleLib.feeOnGross(1, 300), 1);
        assertEq(FeeScheduleLib.feeOnGross(10_000, 300), 300);
        assertEq(FeeScheduleLib.feeOnGross(10_001, 300), 301);
        assertEq(FeeScheduleLib.feeGrossUp(9700, 300), 300);
        assertEq(FeeScheduleLib.feeGrossUp(9701, 300), 301);
        assertEq(FeeScheduleLib.feeOnGross(0, 300), 0);
        assertEq(FeeScheduleLib.feeGrossUp(0, 300), 0);
    }

    function testFuzz_feeOnGross_isCeil(uint256 gross, uint256 bps) public pure {
        gross = bound(gross, 0, type(uint128).max);
        bps = bound(bps, 0, 8500);
        uint256 f = FeeScheduleLib.feeOnGross(gross, bps);
        assertGe(f * 10_000, gross * bps);
        if (f > 0) assertLt((f - 1) * 10_000, gross * bps);
        assertLe(f, gross);
    }

    /// @dev Gross-up identity: a fee on top of a net amount is `b` of the gross flow.
    function testFuzz_grossUpIdentity(uint256 net, uint256 bps) public pure {
        net = bound(net, 0, type(uint128).max);
        bps = bound(bps, 0, 8500);
        uint256 f = FeeScheduleLib.feeGrossUp(net, bps);
        assertEq(f, FeeScheduleLib.feeOnGross(net + f, bps));
    }

    /// @dev Differential against the weekly hook: same surcharge for every (start, decay, elapsed).
    function testFuzz_surchargeMatchesWeeklyHook(
        uint24 base,
        uint24 start,
        uint32 decay,
        uint32 elapsed,
        uint32 launchOffset
    ) public {
        base = uint24(bound(base, 100, 500));
        start = uint24(bound(start, 0, 8000));
        decay = start == 0 ? uint32(bound(decay, 0, 1 days)) : uint32(bound(decay, 1, 1 days));
        elapsed = uint32(bound(elapsed, 0, 2 days));
        uint40 launch = uint40(block.timestamp + bound(launchOffset, 0, 1 hours));

        address weekly = address(uint160(0x4444 << 144) | WEEKLY_FLAGS);
        deployCodeTo(
            "VeradaHook.sol:VeradaHook",
            abi.encode(address(0xA11CE), address(this), address(0xC0)),
            weekly
        );
        address token = address(0x7070);
        IVeradaHook(weekly).configureToken(token, IVeradaHook.FeeConfig(base, start, decay, launch));

        vm.warp(uint256(launch) + elapsed);
        uint256 weeklySurcharge = IVeradaHook(weekly).currentFeeBps(token) - base;
        assertEq(
            FeeScheduleLib.surchargeBps(start, decay, launch, block.timestamp), weeklySurcharge
        );
        IVeradaLiveHook.LiveFeeConfig memory c =
            IVeradaLiveHook.LiveFeeConfig(base, start, decay, launch);
        assertEq(
            FeeScheduleLib.totalBps(c, block.timestamp), IVeradaHook(weekly).currentFeeBps(token)
        );
    }
}
