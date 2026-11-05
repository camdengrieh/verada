// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {RotationScheduleLib} from "../../src/libraries/RotationScheduleLib.sol";

contract RotationScheduleHarness {
    function indexAt(RotationScheduleLib.Schedule memory s, uint256 t)
        external
        pure
        returns (uint64)
    {
        return RotationScheduleLib.indexAt(s, t);
    }
}

contract RotationScheduleLibTest is Test {
    using RotationScheduleLib for RotationScheduleLib.Schedule;

    /// @dev Reference model: an explicit list of segments.
    struct Seg {
        uint256 time;
        uint64 index;
        uint256 len;
    }

    Seg[] internal segs;
    uint256 internal constant T0 = 1_000_000_000;

    function _sched(RotationPeriod p) internal pure returns (RotationScheduleLib.Schedule memory) {
        return RotationScheduleLib.Schedule({
            anchorTime: uint40(T0),
            anchorIndex: 0,
            period: p,
            hasPending: false,
            pendingPeriod: RotationPeriod.OneHour,
            pendingFrom: 0
        });
    }

    function _modelIndex(uint256 t) internal view returns (uint64) {
        uint256 i = segs.length;
        while (segs[i - 1].time > t) --i;
        Seg memory s = segs[i - 1];
        return s.index + uint64((t - s.time) / s.len);
    }

    function _modelStart(uint64 n) internal view returns (uint256) {
        uint256 i = segs.length;
        while (segs[i - 1].index > n) --i;
        Seg memory s = segs[i - 1];
        return s.time + uint256(n - s.index) * s.len;
    }

    function _modelSchedule(uint256 t, RotationPeriod p) internal {
        uint64 next = _modelIndex(t) + 1;
        uint256 start = _modelStart(next);
        while (segs[segs.length - 1].index >= next) segs.pop();
        segs.push(Seg(start, next, RotationScheduleLib.length(p)));
    }

    function test_lengthsAndBuffers() public pure {
        assertEq(RotationScheduleLib.length(RotationPeriod.OneHour), 3600);
        assertEq(RotationScheduleLib.length(RotationPeriod.TwelveHours), 43_200);
        assertEq(RotationScheduleLib.length(RotationPeriod.OneDay), 86_400);
        assertEq(RotationScheduleLib.length(RotationPeriod.ThreeDays), 259_200);
        assertEq(RotationScheduleLib.length(RotationPeriod.OneWeek), 604_800);
        assertEq(RotationScheduleLib.closeBuffer(RotationPeriod.OneHour), 900);
        assertEq(RotationScheduleLib.closeBuffer(RotationPeriod.TwelveHours), 10_800);
        assertEq(RotationScheduleLib.closeBuffer(RotationPeriod.OneDay), 21_600);
        assertEq(RotationScheduleLib.closeBuffer(RotationPeriod.ThreeDays), 21_600);
        assertEq(RotationScheduleLib.closeBuffer(RotationPeriod.OneWeek), 21_600);
    }

    /// @dev The schedule worked example, verbatim.
    function test_workedExample() public pure {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod.OneWeek);
        s = s.schedule(T0 + 864_000, RotationPeriod.OneHour);
        assertEq(s.indexAt(T0 + 864_000), 1);
        assertEq(s.pendingFrom, 2);
        assertEq(s.switchAt(), T0 + 1_209_600);
        assertEq(s.startOf(1), T0 + 604_800);
        assertEq(s.startOf(2) - RotationScheduleLib.closeBuffer(s.periodOf(1)), T0 + 1_188_000);
        assertEq(s.startOf(3) - RotationScheduleLib.closeBuffer(s.periodOf(2)), T0 + 1_212_300);
        assertEq(s.indexAt(T0 + 1_212_700), 2);
        assertEq(s.indexAt(T0 + 1_213_500), 3);
        assertEq(s.indexAt(T0 + 1_214_999), 3);

        uint256 sw = s.switchAt();
        s = s.schedule(sw + 19_800, RotationPeriod.ThreeDays);
        assertEq(s.anchorTime, sw, "synced to the hourly segment");
        assertEq(s.anchorIndex, 2);
        assertEq(s.indexAt(sw + 19_800), 7);
        assertEq(s.pendingFrom, 8);
        assertEq(s.switchAt(), T0 + 1_231_200);
        uint256 q = s.switchAt() + 360_000;
        assertEq(s.indexAt(q), 9);
        assertEq(s.startOf(9), T0 + 1_490_400);
        assertEq(s.startOf(10), T0 + 1_749_600);
        assertEq((q - T0) / 259_200, 6, "naive division collides");
    }

    function testFuzz_boundarySeconds(uint8 p, uint32 n) public pure {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod(p % 5));
        uint64 k = uint64(bound(n, 1, 1_000_000));
        uint256 start = s.startOf(k);
        assertEq(s.indexAt(start), k);
        assertEq(s.indexAt(start - 1), k - 1);
    }

    function test_overwritePendingBeforeItApplies() public pure {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod.OneDay);
        s = s.schedule(T0 + 10, RotationPeriod.OneHour);
        s = s.schedule(T0 + 20, RotationPeriod.OneWeek);
        assertEq(s.pendingFrom, 1);
        assertEq(uint8(s.pendingPeriod), uint8(RotationPeriod.OneWeek));
        assertEq(s.startOf(2), T0 + 1 days + 7 days);
    }

    function testFuzz_againstModel(
        uint8 p0,
        uint32[8] memory gaps,
        uint8[8] memory periods,
        uint32[4] memory probes
    ) public {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod(p0 % 5));
        delete segs;
        segs.push(Seg(T0, 0, RotationScheduleLib.length(s.period)));
        uint256 t = T0;
        for (uint256 i; i < gaps.length; ++i) {
            t += bound(gaps[i], 0, 3 weeks);
            RotationPeriod p = RotationPeriod(periods[i] % 5);
            uint64 before = s.indexAt(t);
            s = s.schedule(t, p);
            _modelSchedule(t, p);
            assertEq(s.indexAt(t), before, "scheduling never moves the current rotation");
            assertEq(s.pendingFrom, before + 1, "always the next boundary");
            for (uint256 j; j < probes.length; ++j) {
                uint256 q = t + bound(probes[j], 0, 6 weeks);
                uint64 idx = s.indexAt(q);
                assertEq(idx, _modelIndex(q), "index");
                uint256 st = s.startOf(idx);
                assertEq(st, _modelStart(idx), "start");
                assertLe(st, q, "G1 lower");
                assertGt(s.startOf(idx + 1), q, "G1 upper");
                assertEq(
                    s.startOf(idx + 1) - st,
                    RotationScheduleLib.length(s.periodOf(idx)),
                    "G7 period constant within a rotation"
                );
            }
        }
    }

    function testFuzz_indexMonotonic(uint8 p, uint32 a, uint32 b) public pure {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod(p % 5));
        s = s.schedule(T0 + 5 days, RotationPeriod(uint8((uint256(p) + 1) % 5)));
        uint256 x = T0 + bound(a, 0, 30 days);
        uint256 y = x + bound(b, 0, 30 days);
        assertLe(s.indexAt(x), s.indexAt(y));
    }

    function test_uint64Headroom() public {
        RotationScheduleLib.Schedule memory s = _sched(RotationPeriod.OneHour);
        s.anchorIndex = type(uint64).max - 10;
        assertEq(s.indexAt(T0 + 5 hours), type(uint64).max - 5);
        assertEq(s.indexAt(T0 + 10 hours), type(uint64).max);
        RotationScheduleHarness h = new RotationScheduleHarness();
        vm.expectRevert(RotationScheduleLib.IndexOverflow.selector);
        h.indexAt(s, T0 + 11 hours);
        // Hourly rotations for 10,000 years stay far below the limit.
        s.anchorIndex = 0;
        assertLt(s.indexAt(T0 + 10_000 * 365 days), type(uint32).max);
    }
}
