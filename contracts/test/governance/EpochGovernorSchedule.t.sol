// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "../utils/BallotLog.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";

/// @dev The owner-settable epoch schedule: a trading phase then a voting phase, applied from the
///      next epoch, and the owner-set graces. Same fixture as `EpochGovernorTest` (the token's
///      ballot is [A, B]); epoch 0 is the weekly epoch the governor is deployed in.
contract EpochGovernorScheduleTest is BallotLog {
    uint256 internal constant WEEK = 7 days;
    uint256 internal constant T0 = 1_750_000_123;
    uint64 internal constant HUNGER = uint64(1) << 2;
    uint16 internal constant AFRICA = uint16(1) << 0;

    // 30 minutes of trading, then 15 minutes of voting.
    uint256 internal constant LEN = 45 minutes;
    uint256 internal constant VOTE = 15 minutes;
    uint256 internal constant HOLD = 30 minutes;

    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    CatalogFixture internal cat;
    CauseRegistry internal registry;
    MockOrgFactory internal orgFactory;
    EpochGovernor internal gov;
    VaradaToken internal tokenContract;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal v1 = makeAddr("v1");
    address internal v2 = makeAddr("v2");
    address internal v4 = makeAddr("v4");
    address internal v5 = makeAddr("v5");

    bytes32 internal orgA = bytes32("orgA");
    bytes32 internal orgB = bytes32("orgB");
    bytes32 internal orgC = bytes32("orgC");
    bytes32 internal causeC = keccak256(abi.encode(orgC));

    mapping(uint256 entry => IEpochGovernor.Pin) internal _pinCache;

    function setUp() public {
        _recordBallots();
        vm.warp(T0 - WEEK);
        tokenContract = new VaradaToken("Varada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        _give(v1, 100e18);
        _give(v2, 250e18);
        vm.warp(T0 + WEEK);

        MockUSDC usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(2);
        profiles = new MockProfileRegistryLite();

        cat = new CatalogFixture();
        cat.add(cat.bucketOf(2, 0), orgA);
        cat.add(cat.bucketOf(2, 0), orgB);
        cat.add(cat.bucketOf(2, 2), orgC);
        cat.publish();
        for (uint256 e; e < 2; ++e) {
            IEpochGovernor.Pin memory p = cat.pin(e);
            IEpochGovernor.Pin storage c = _pinCache[e];
            c.orgId = p.orgId;
            c.bucket = p.bucket;
            c.index = p.index;
            c.proof = p.proof;
        }

        gov = _newGov();
        profiles.register(token, creator);
        profiles.setFocus(token, HUNGER, AFRICA);
        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        registry.addCause(causeC, orgC, orgFactory.computeOrgAddress(orgC), "meta");
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        IEpochGovernor.Pin[] memory pins_ = new IEpochGovernor.Pin[](2);
        pins_[0] = _pinCache[0];
        pins_[1] = _pinCache[1];
        vm.prank(creator);
        gov.setShortlist(token, pins_);
    }

    function _newGov() internal returns (EpochGovernor g) {
        g = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            scheme,
            ITokenProfileRegistry(address(profiles))
        );
        scheme.setGovernor(address(g), true);
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        tokenContract.transfer(to, amount);
    }

    function _schedule() internal {
        vm.prank(owner);
        gov.setEpochSchedule(LEN, VOTE, HOLD);
    }

    function _cast(address voter, uint256 epoch) internal returns (bytes32) {
        vm.prank(voter);
        return scheme.castBallot(address(gov), token, epoch, abi.encode(uint8(0)));
    }

    // ---- defaults

    function test_defaults_equalPreviousConstants() public view {
        assertEq(gov.epochLength(), 7 days);
        assertEq(gov.votingWindow(), 7 days);
        assertEq(gov.holdWindow(), 7 days);
        assertEq(gov.tallyGrace(), 14 days);
        assertEq(gov.launchSnapshotDelay(), 1 days);
        assertEq(gov.curationGrace(), 6 hours);
        assertEq(gov.MIN_DURATION(), 5 minutes);
        assertEq(gov.MAX_DURATION(), 30 days);
        assertEq(gov.epochStart(3), gov.epochZeroStart() + 3 * WEEK);
        // Voting is open the whole epoch.
        assertEq(gov.votingOpensAt(0), gov.epochStart(0));
        assertEq(gov.votingOpensAt(7), gov.epochStart(7));
        assertEq(gov.snapshotOf(2), gov.epochStart(2) - 1);
    }

    // ---- setters: access and bounds

    function test_setters_onlyOwner() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        bytes memory denied =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(denied);
        gov.setEpochSchedule(LEN, VOTE, HOLD);
        vm.expectRevert(denied);
        gov.setTallyGrace(1 hours);
        vm.expectRevert(denied);
        gov.setLaunchSnapshotDelay(1 hours);
        vm.expectRevert(denied);
        gov.setCurationGrace(1 hours);
        vm.stopPrank();
    }

    function _outOfRange(uint256 v, uint256 lo, uint256 hi) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEpochGovernor.DurationOutOfRange.selector, v, lo, hi);
    }

    function test_setEpochSchedule_bounds() public {
        uint256 lo = 5 minutes;
        uint256 hi = 30 days;
        vm.startPrank(owner);
        vm.expectRevert(_outOfRange(lo - 1, lo, hi));
        gov.setEpochSchedule(lo - 1, lo, lo);
        vm.expectRevert(_outOfRange(hi + 1, lo, hi));
        gov.setEpochSchedule(hi + 1, lo, lo);
        // Voting window: at least the floor, at most the epoch length.
        vm.expectRevert(_outOfRange(lo - 1, lo, LEN));
        gov.setEpochSchedule(LEN, lo - 1, HOLD);
        vm.expectRevert(_outOfRange(LEN + 1, lo, LEN));
        gov.setEpochSchedule(LEN, LEN + 1, HOLD);
        // Hold window.
        vm.expectRevert(_outOfRange(lo - 1, lo, hi));
        gov.setEpochSchedule(LEN, VOTE, lo - 1);
        vm.expectRevert(_outOfRange(hi + 1, lo, hi));
        gov.setEpochSchedule(LEN, VOTE, hi + 1);
        // Edges are accepted.
        gov.setEpochSchedule(lo, lo, lo);
        gov.setEpochSchedule(hi, hi, hi);
        gov.setEpochSchedule(LEN, LEN, HOLD);
        vm.stopPrank();
    }

    function test_graceSetters_boundsAndEvents() public {
        uint256 lo = 5 minutes;
        uint256 hi = 30 days;
        vm.startPrank(owner);
        vm.expectRevert(_outOfRange(lo - 1, lo, hi));
        gov.setTallyGrace(lo - 1);
        vm.expectRevert(_outOfRange(hi + 1, lo, hi));
        gov.setTallyGrace(hi + 1);
        vm.expectRevert(_outOfRange(lo - 1, lo, hi));
        gov.setLaunchSnapshotDelay(lo - 1);
        vm.expectRevert(_outOfRange(hi + 1, lo, hi));
        gov.setLaunchSnapshotDelay(hi + 1);
        vm.expectRevert(_outOfRange(lo - 1, lo, hi));
        gov.setCurationGrace(lo - 1);
        vm.expectRevert(_outOfRange(hi + 1, lo, hi));
        gov.setCurationGrace(hi + 1);

        vm.expectEmit(address(gov));
        emit IEpochGovernor.TallyGraceSet(1 hours);
        gov.setTallyGrace(1 hours);
        vm.expectEmit(address(gov));
        emit IEpochGovernor.LaunchSnapshotDelaySet(10 minutes);
        gov.setLaunchSnapshotDelay(10 minutes);
        vm.expectEmit(address(gov));
        emit IEpochGovernor.CurationGraceSet(30 minutes);
        gov.setCurationGrace(30 minutes);
        vm.stopPrank();
        assertEq(gov.tallyGrace(), 1 hours);
        assertEq(gov.launchSnapshotDelay(), 10 minutes);
        assertEq(gov.curationGrace(), 30 minutes);
    }

    // ---- the schedule applies from the next epoch

    function test_lengthChange_takesEffectNextEpoch() public {
        uint256 e0Start = gov.epochStart(0);
        uint256 e1Start = gov.epochStart(1);
        assertEq(gov.currentEpoch(), 0);

        vm.expectEmit(address(gov));
        emit IEpochGovernor.EpochScheduleSet(1, e1Start, LEN, VOTE, HOLD);
        _schedule();

        // The running epoch is untouched.
        assertEq(gov.currentEpoch(), 0);
        assertEq(gov.epochLength(), WEEK);
        assertEq(gov.votingWindow(), WEEK);
        assertEq(gov.holdWindow(), WEEK);
        assertEq(gov.epochStart(0), e0Start);
        assertEq(gov.epochStart(1), e1Start);
        assertEq(gov.votingOpensAt(0), e0Start);
        (uint256 l0, uint256 w0, uint256 h0) = gov.epochScheduleFor(0);
        assertEq(l0, WEEK);
        assertEq(w0, WEEK);
        assertEq(h0, WEEK);
        // From epoch 1 the new schedule applies, with no gap or overlap.
        (uint256 l1, uint256 w1, uint256 h1) = gov.epochScheduleFor(1);
        assertEq(l1, LEN);
        assertEq(w1, VOTE);
        assertEq(h1, HOLD);
        assertEq(gov.epochStart(2), e1Start + LEN);
        assertEq(gov.epochStart(10), e1Start + 9 * LEN);
        assertEq(gov.votingOpensAt(1), e1Start + LEN - VOTE);
        assertEq(gov.snapshotOf(1), e1Start - 1);

        vm.warp(e1Start - 1);
        assertEq(gov.currentEpoch(), 0);
        vm.warp(e1Start);
        assertEq(gov.currentEpoch(), 1);
        assertEq(gov.epochLength(), LEN);
        assertEq(gov.votingWindow(), VOTE);
        assertEq(gov.holdWindow(), HOLD);
        vm.warp(e1Start + LEN - 1);
        assertEq(gov.currentEpoch(), 1);
        vm.warp(e1Start + LEN);
        assertEq(gov.currentEpoch(), 2);
        vm.warp(e1Start + 7 * LEN + 5);
        assertEq(gov.currentEpoch(), 8);
    }

    function test_changeWhilePending_replacesIt_thenLaterChangeAddsSegment() public {
        uint256 e1Start = gov.epochStart(1);
        _schedule();
        vm.prank(owner);
        gov.setEpochSchedule(60 minutes, 20 minutes, 40 minutes); // replaces the pending one
        assertEq(gov.epochStart(2), e1Start + 60 minutes);
        (uint256 l, uint256 w, uint256 h) = gov.epochScheduleFor(1);
        assertEq(l, 60 minutes);
        assertEq(w, 20 minutes);
        assertEq(h, 40 minutes);

        // Once epoch 1 runs, a new change applies from epoch 2 and leaves epoch 1 alone.
        vm.warp(e1Start + 10 minutes);
        vm.prank(owner);
        gov.setEpochSchedule(LEN, VOTE, HOLD);
        assertEq(gov.currentEpoch(), 1);
        assertEq(gov.epochLength(), 60 minutes);
        assertEq(gov.epochStart(2), e1Start + 60 minutes);
        assertEq(gov.epochStart(3), e1Start + 60 minutes + LEN);
        assertEq(gov.votingOpensAt(1), e1Start + 40 minutes);
        assertEq(gov.votingOpensAt(2), e1Start + 60 minutes + LEN - VOTE);
        vm.warp(e1Start + 60 minutes);
        assertEq(gov.currentEpoch(), 2);
        assertEq(gov.epochLength(), LEN);
    }

    /// Before any token registers nothing can hold state, so the first schedule re-anchors epoch
    /// zero and the first cycle is already short; afterwards changes wait for the next epoch.
    function test_beforeFirstToken_scheduleAppliesAtOnce() public {
        EpochGovernor fresh = _newGov();
        vm.prank(owner);
        fresh.setEpochSchedule(LEN, VOTE, HOLD);
        assertEq(fresh.epochLength(), LEN);
        assertEq(fresh.votingWindow(), VOTE);
        assertEq(fresh.holdWindow(), HOLD);
        uint256 zero = fresh.epochZeroStart();
        uint256 epoch = (block.timestamp - zero) / LEN;
        assertEq(fresh.currentEpoch(), epoch);
        assertEq(fresh.epochStart(epoch + 1), zero + (epoch + 1) * LEN);
        assertEq(fresh.votingOpensAt(epoch), zero + (epoch + 1) * LEN - VOTE);
        // A second pre-launch change replaces it too.
        vm.prank(owner);
        fresh.setEpochSchedule(60 minutes, 30 minutes, 30 minutes);
        assertEq(fresh.epochLength(), 60 minutes);

        // The first registration closes that window.
        vm.startPrank(owner);
        fresh.setFactory(factory);
        registry.setMaterializer(address(fresh), true);
        vm.stopPrank();
        vm.prank(factory);
        fresh.registerToken(token);
        uint256 cur = fresh.currentEpoch();
        uint256 end = fresh.epochStart(cur + 1);
        vm.prank(owner);
        fresh.setEpochSchedule(LEN, VOTE, HOLD);
        assertEq(fresh.epochLength(), 60 minutes);
        assertEq(fresh.currentEpoch(), cur);
        assertEq(fresh.epochStart(cur + 1), end);
        assertEq(fresh.epochStart(cur + 2), end + LEN);
    }

    // ---- ballots only in the voting window

    function test_ballots_onlyInVotingWindow_boundaries() public {
        _schedule();
        uint256 s = gov.epochStart(1);
        vm.warp(s);
        gov.openEpoch(token, 1);
        uint256 opens = gov.votingOpensAt(1);
        assertEq(opens, s + 30 minutes);

        // Trading phase: no ballots.
        vm.warp(s);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.VotingNotOpen.selector, 1, opens));
        _cast(v1, 1);
        vm.warp(opens - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.VotingNotOpen.selector, 1, opens));
        _cast(v1, 1);
        assertFalse(gov.hasVoted(token, 1, v1));

        // The first second of the voting phase and its last second both count.
        vm.warp(opens);
        _cast(v1, 1);
        assertTrue(gov.hasVoted(token, 1, v1));
        vm.warp(s + LEN - 1);
        _cast(v2, 1);
        assertEq(gov.voterCount(token, 1), 2);

        // The epoch is over: no ballots for it any more.
        vm.warp(s + LEN);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.EpochNotCurrent.selector, 1));
        _cast(v1, 1);
    }

    /// The default voting window is the whole epoch: ballots from its first second, as before.
    function test_defaultSchedule_votesFromEpochStart() public {
        gov.openEpoch(token, 0);
        vm.warp(gov.epochStart(0) + 1);
        _cast(v1, 0);
        assertTrue(gov.hasVoted(token, 0, v1));
    }

    /// Weights are the lowest balance over the hold window ending at the snapshot before the
    /// epoch: a buyer inside it has none, a buyer before it has full weight.
    function test_holdWindow_usesTradingPhaseLength() public {
        _schedule();
        uint256 s = gov.epochStart(1);
        // Epoch 0 keeps its weekly hold window.
        assertEq(gov.holdFromFor(token, 0), gov.snapshotOf(0) - WEEK);

        vm.warp(s - 40 minutes);
        _give(v5, 50e18); // before the 30 minute window opens
        vm.warp(s - 20 minutes);
        _give(v4, 50e18); // inside it
        vm.warp(s);

        assertEq(gov.snapshotFor(token, 1), s - 1);
        assertEq(gov.holdFromFor(token, 1), s - 1 - HOLD);
        assertEq(gov.weightOf(token, 1, v1), 100);
        assertEq(gov.weightOf(token, 1, v5), 50);
        assertEq(gov.weightOf(token, 1, v4), 0);

        gov.openEpoch(token, 1);
        vm.warp(gov.votingOpensAt(1));
        _cast(v5, 1);
        vm.expectRevert(IEpochGovernor.InvalidVote.selector);
        _cast(v4, 1);
    }

    // ---- graces

    /// A shorter tally grace applies at once to an epoch that has no tally yet.
    function test_tallyGrace_appliesImmediately() public {
        vm.prank(owner);
        gov.setDefaultCause(causeC);
        gov.openEpoch(token, 0);
        vm.warp(gov.epochStart(0) + 1);
        _cast(v1, 0);
        scheme.setGovernor(address(gov), false);
        vm.warp(gov.epochStart(1));
        gov.closeEpoch(token, 0);

        vm.prank(owner);
        gov.setTallyGrace(1 hours);
        uint256 graceEnd = gov.epochStart(1) + 1 hours;
        bytes32[] memory orgs = _orgIds(address(gov), token, 0);
        vm.warp(graceEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TallyNotFinal.selector, token, 0));
        gov.finalizeEpoch(token, 0, orgs);
        vm.warp(graceEnd);
        gov.finalizeEpoch(token, 0, orgs);
        assertEq(gov.winningCause(token, 0), causeC);
    }

    /// A launch delay set afterwards applies to later registrations only: a running vote's hold
    /// window does not move.
    function test_launchSnapshotDelay_appliesToLaterRegistrations() public {
        _schedule();
        vm.warp(gov.epochStart(1));
        VaradaToken t2 = new VaradaToken("T2", "T2", "ipfs://m", creator, factory);
        profiles.register(address(t2), creator);
        profiles.setFocus(address(t2), HUNGER, AFRICA);
        vm.prank(factory);
        gov.registerToken(address(t2));
        // Created in this epoch with no supply at its snapshot: launch snapshot halfway to the
        // end of the 45 minute epoch (22.5 minutes), under the 1 day cap.
        uint256 launch = gov.launchSnapshotOf(address(t2));
        assertEq(launch, block.timestamp + LEN / 2);
        uint256 from = gov.holdFromFor(address(t2), 1);
        vm.prank(owner);
        gov.setLaunchSnapshotDelay(5 minutes);
        assertEq(gov.holdFromFor(address(t2), 1), from);
        assertEq(gov.launchSnapshotOf(address(t2)), launch);
    }
}
