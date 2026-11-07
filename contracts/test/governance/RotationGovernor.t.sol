// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IOutcomeVotingScheme, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogPublish, CatalogTree} from "../utils/CatalogFixture.sol";

/// @dev Shared governor fixture: a real VaradaToken whose supply is split between the pool
///      manager stand-in (70%) and three holders, twelve active catalogue causes and the
///      plaintext scheme. The token's focus (hunger x Africa) holds causes 0..2 only, a pool no
///      larger than the ballot, so every round's ballot is those three in order.
abstract contract RotationGovernorBase is Test {
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    CauseRegistry internal causes;
    CauseCatalog internal catalog;
    RotationGovernor internal gov;
    VaradaToken internal token;

    address internal pm = makeAddr("poolManager");
    address internal alice = makeAddr("alice"); // 20%
    address internal bob = makeAddr("bob"); // 9%
    address internal carol = makeAddr("carol"); // 1%
    address internal dave = makeAddr("dave"); // buys later
    address internal controller = makeAddr("controller");

    bytes32[] internal causeIds;
    bytes32[] internal orgIds;
    /// @dev The focus pool (orgs of causes 0..2) and its catalogue leaves.
    bytes32[] internal poolOrgs;
    bytes32[] internal poolLeaves;
    uint256 internal t0;

    function _params() internal pure virtual returns (IRotationGovernor.Params memory) {
        return IRotationGovernor.Params({
            votingPeriod: 24 hours,
            executionWindow: 3 days,
            cooldown: 7 days,
            quorumBps: 1000,
            proposalThresholdBps: 50
        });
    }

    function _baseSetUp(RotationPeriod period) internal {
        vm.warp(1_700_000_000);
        MockUSDC usdc = new MockUSDC();
        MockEndaomentRegistry endRegistry =
            new MockEndaomentRegistry(address(usdc), makeAddr("endTreasury"));
        MockOrgFactory endFactory = new MockOrgFactory(endRegistry);
        causes = new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(endFactory)));
        for (uint256 i; i < 12; ++i) {
            bytes32 orgId = bytes32(uint256(1000 + i));
            bytes32 id = causes.causeIdOf(orgId);
            causes.addCause(id, orgId, endFactory.computeOrgAddress(orgId), "");
            causeIds.push(id);
            orgIds.push(orgId);
            if (i < 3) poolOrgs.push(orgId);
        }
        catalog = new CauseCatalog(address(this));
        poolLeaves = CatalogPublish.publish(catalog, poolOrgs);
        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        gov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ICauseCatalog(address(catalog)),
            ITokenProfileRegistry(address(profiles)),
            pm,
            IOutcomeVotingScheme(address(scheme)),
            _params()
        );
        scheme.setGovernor(address(gov), true);
        causes.setMaterializer(address(gov), true);
        gov.setVault(address(this));

        token = _newToken();
        // Holders hold for a week before registration, so every hold window of the fixture's
        // early rotations is covered.
        vm.warp(block.timestamp + 7 days);
        t0 = block.timestamp;
        _register(address(token), period);
        profiles.register(address(token), controller);
    }

    /// @dev Gives `t` the fixture's focus and registers it with cause 0.
    function _register(address t, RotationPeriod period) internal {
        profiles.setFocus(t, CatalogPublish.CATEGORIES, CatalogPublish.REGIONS);
        gov.registerToken(t, causeIds[0], period);
    }

    /// @dev The draws of the fixture's pool: every entry in order (it fits the ballot).
    function _draws() internal view returns (IEpochGovernor.Draw[] memory) {
        return CatalogPublish.allDraws(poolOrgs, poolLeaves);
    }

    /// @dev Prepares (and opens) round `target` of `t`.
    function _prep(address t, uint64 target) internal {
        gov.prepareRound(t, target, _draws());
    }

    /// @dev The ballot every fixture round gets: causes 0..2.
    function _poolCauses() internal view returns (bytes32[] memory l) {
        l = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            l[i] = causeIds[i];
        }
    }

    function _newToken() internal returns (VaradaToken t) {
        t = new VaradaToken("T", "T", "", address(this), address(this));
        uint256 unit = 1e9 * 1e18;
        t.transfer(pm, 70 * unit);
        t.transfer(alice, 20 * unit);
        t.transfer(bob, 9 * unit);
        t.transfer(carol, 1 * unit);
    }

    function _rot(uint64 target) internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
    }

    function _per(uint64 id) internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id);
    }

    /// @dev Prepares round `target` first if nobody did.
    function _vote(address voter, uint64 target, uint8 choice) internal {
        if (_status(target) == IRotationGovernor.RoundStatus.None) _prep(address(token), target);
        vm.prank(voter);
        scheme.castBallot(address(gov), address(token), _rot(target), abi.encode(choice));
    }

    function _votePeriod(address voter, uint64 id, bool support) internal {
        vm.prank(voter);
        scheme.castBallot(
            address(gov), address(token), _per(id), abi.encode(uint8(support ? 1 : 0))
        );
    }

    function _voteEnd(uint64 target) internal view returns (uint40 end) {
        (,, end,,,,) = gov.roundOf(address(token), target);
    }

    function _status(uint64 target) internal view returns (IRotationGovernor.RoundStatus st) {
        (st,,,,,,) = gov.roundOf(address(token), target);
    }

    /// @dev Closes `target` at its vote end, publishes the plaintext tally and finalizes it.
    function _settle(uint64 target) internal {
        vm.warp(_voteEnd(target));
        gov.closeRound(address(token), target);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(target));
        gov.finalizeRound(address(token), target);
    }

    function _active() internal view returns (bytes32 c) {
        (c,) = gov.activeCause(address(token));
    }

    /// @dev Proposes, votes FOR with alice, closes, tallies and executes a period change.
    function _changePeriod(RotationPeriod p) internal returns (uint64 id) {
        vm.prank(alice);
        id = gov.proposePeriod(address(token), p);
        _votePeriod(alice, id, true);
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        assertTrue(gov.executePeriodProposal(id));
    }
}

contract RotationGovernorTest is RotationGovernorBase {
    function setUp() public {
        _baseSetUp(RotationPeriod.OneDay);
    }

    // ------------------------------------------------------------------ registration and views

    function test_registration() public view {
        assertTrue(gov.isRegistered(address(token)));
        (bytes32 c, uint64 r) = gov.activeCause(address(token));
        assertEq(c, causeIds[0]);
        assertEq(r, 0);
        assertEq(gov.rotationStart(address(token), 0), t0);
        assertEq(gov.rotationStart(address(token), 3), t0 + 3 days);
        (RotationPeriod cur, bool pending,,) = gov.periodOf(address(token));
        assertEq(uint8(cur), uint8(RotationPeriod.OneDay));
        assertFalse(pending);
    }

    function test_registration_checks() public {
        vm.prank(alice);
        vm.expectRevert(IRotationGovernor.NotVault.selector);
        gov.registerToken(address(1), causeIds[0], RotationPeriod.OneHour);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.AlreadyRegistered.selector, address(token))
        );
        gov.registerToken(address(token), causeIds[0], RotationPeriod.OneHour);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.InactiveCause.selector, bytes32(0))
        );
        gov.registerToken(address(1), bytes32(0), RotationPeriod.OneHour);
        causes.deactivateCause(causeIds[5]);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.InactiveCause.selector, causeIds[5])
        );
        gov.registerToken(address(1), causeIds[5], RotationPeriod.OneHour);
    }

    function test_setVault_once() public {
        vm.expectRevert(IRotationGovernor.VaultAlreadySet.selector);
        gov.setVault(address(2));
    }

    function test_views_unknownToken() public view {
        (bytes32 c, uint64 r) = gov.activeCause(address(7));
        assertEq(c, bytes32(0));
        assertEq(r, 0);
        assertEq(gov.currentRotation(address(7)), 0);
        assertEq(gov.rotationStart(address(7), 4), 0);
        (uint40 s, uint40 vs, uint40 ve) = gov.pollWindow(address(7), 2);
        assertEq(uint256(s) + vs + ve, 0);
        assertEq(gov.activeCauseAt(address(7), block.timestamp), bytes32(0));
    }

    function test_everyPeriod_lengthAndBuffer() public {
        uint256[5] memory lengths = [uint256(3600), 43_200, 86_400, 259_200, 604_800];
        uint256[5] memory buffers = [uint256(900), 10_800, 21_600, 21_600, 21_600];
        for (uint8 i; i < 5; ++i) {
            VaradaToken t = _newToken();
            _register(address(t), RotationPeriod(i));
            uint256 s0 = gov.rotationStart(address(t), 0);
            assertEq(gov.rotationStart(address(t), 1) - s0, lengths[i]);
            (uint40 snap, uint40 vs, uint40 ve) = gov.pollWindow(address(t), 1);
            assertEq(snap, s0 - 1);
            assertEq(vs, s0);
            assertEq(ve, s0 + lengths[i] - buffers[i]);
            assertEq(gov.rotationAt(address(t), s0 + lengths[i] - 1), 0);
            assertEq(gov.rotationAt(address(t), s0 + lengths[i]), 1);
        }
    }

    // ------------------------------------------------------------------ opening and ballots

    function test_openRound_explicit() public {
        vm.warp(t0 + 1 days + 10);
        bytes32[] memory opts = _poolCauses();
        vm.expectEmit(address(gov));
        emit IRotationGovernor.BallotPrepared(address(token), 2, 1, 3, 0, opts);
        vm.expectEmit(address(gov));
        emit IRotationGovernor.RoundOpened(
            address(token),
            2,
            _rot(2),
            opts,
            uint40(t0 + 1 days - 1),
            uint40(t0 + 2 days - 6 hours),
            address(scheme)
        );
        _prep(address(token), 2);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.Open));
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.RoundAlreadyOpened.selector, address(token), uint64(2)
            )
        );
        _prep(address(token), 2);
        // Without draws the pool cannot fill the ballot.
        vm.warp(t0 + 2 days + 10);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEpochGovernor.IncompleteBallot.selector, address(token), uint256(3), uint256(0)
            )
        );
        gov.openRound(address(token));
    }

    function test_noLazyOpening_ballotBeforePreparationReverts() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundNotOpened.selector, address(token), 2)
        );
        scheme.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(1)));
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.None));
        _vote(alice, 2, 1);
        (IRotationGovernor.RoundStatus st,,, uint32 voters,,, bytes32[] memory opts) =
            gov.roundOf(address(token), 2);
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Open));
        assertEq(voters, 1);
        assertEq(opts.length, 3);
        assertTrue(gov.hasVotedRound(address(token), 2, alice));
    }

    function test_openRound_afterVoteEnd_closed() public {
        vm.warp(t0 + 2 days - 6 hours);
        IEpochGovernor.Draw[] memory d = _draws();
        vm.expectRevert(IRotationGovernor.VotingClosed.selector);
        gov.prepareRound(address(token), 2, d);
    }

    function test_rotationOne_hasNoWeight() public {
        // For a token registered as it is created (as the factory does), the round for
        // rotation 1 snapshots before launch, so nobody can vote in it.
        VaradaToken fresh = _newToken();
        _register(address(fresh), RotationPeriod.OneDay);
        vm.warp(block.timestamp + 10);
        _prep(address(fresh), 1);
        vm.prank(alice);
        vm.expectRevert(IRotationGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), address(fresh), _rot(1), abi.encode(uint8(1)));
    }

    function test_snapshot_buyThenVoteHasNoWeight() public {
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        vm.prank(alice);
        token.transfer(dave, 1e9 * 1e18);
        vm.prank(dave);
        vm.expectRevert(IRotationGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(1)));
        // Alice keeps her snapshot weight even after selling.
        _vote(alice, 2, 1);
        assertEq(scheme.liveCounts(address(gov), address(token), _rot(2))[1], 20e9);
    }

    function test_snapshot_flashTransferSameBlock() public {
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        vm.prank(alice);
        token.transfer(dave, 20e9 * 1e18);
        vm.prank(dave);
        vm.expectRevert(IRotationGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(0)));
        vm.prank(dave);
        token.transfer(alice, 20e9 * 1e18);
        assertEq(token.getPastVotes(dave, t0 + 1 days - 1), 0);
    }

    function test_ballot_checks() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.AlreadyVoted.selector, alice));
        scheme.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(1)));

        // Not the scheme.
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.NotScheme.selector, address(this)));
        gov.authorizeBallot(address(token), _rot(2), alice, bytes32(0));

        // Not the current target.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.RoundNotCurrent.selector, 3));
        scheme.castBallot(address(gov), address(token), _rot(3), abi.encode(uint8(1)));

        // Invalid scopes: unknown kind and dirty middle bits.
        uint256 bad = (uint256(3) << 248) | 2;
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(PollScopeLib.InvalidScope.selector, bad));
        gov.authorizeBallot(address(token), bad, bob, bytes32(0));
        uint256 dirty = _rot(2) | (uint256(1) << 100);
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(PollScopeLib.InvalidScope.selector, dirty));
        gov.authorizeBallot(address(token), dirty, bob, bytes32(0));

        // After the vote end.
        vm.warp(_voteEnd(2));
        vm.prank(bob);
        vm.expectRevert(IRotationGovernor.VotingClosed.selector);
        scheme.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(1)));
    }

    function test_schemeSwap_onlyAffectsNewRounds() public {
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        MockVotingScheme s2 = new MockVotingScheme();
        s2.setGovernor(address(gov), true);
        gov.setScheme(IOutcomeVotingScheme(address(s2)));
        _vote(alice, 2, 1); // still the old scheme
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.NotScheme.selector, address(s2)));
        s2.castBallot(address(gov), address(token), _rot(2), abi.encode(uint8(1)));
        assertEq(gov.roundScheme(address(token), 2), address(scheme));
    }

    // ------------------------------------------------------------------ close and finalize

    function test_close_checks() public {
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundNotOpened.selector, address(token), 2)
        );
        gov.closeRound(address(token), 2);
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.expectRevert(IRotationGovernor.VotingNotEnded.selector);
        gov.closeRound(address(token), 2);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundAlreadyClosed.selector, address(token), 2)
        );
        gov.closeRound(address(token), 2);
    }

    function test_close_zeroVoters_noChange() public {
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        vm.warp(_voteEnd(2));
        vm.expectEmit(address(gov));
        emit IRotationGovernor.RoundFinalized(
            address(token), 2, IRotationGovernor.RoundStatus.NoChange, bytes32(0), 0
        );
        gov.closeRound(address(token), 2);
        assertFalse(scheme.isClosed(address(gov), address(token), _rot(2)), "no tally requested");
        vm.warp(t0 + 2 days);
        assertEq(_active(), causeIds[0], "current cause continues");
    }

    function test_finalize_onTime() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        _vote(bob, 2, 2);
        _settle(2);
        (IRotationGovernor.RoundStatus st,,,, bytes32 winner, uint64 from,) =
            gov.roundOf(address(token), 2);
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Applied));
        assertEq(winner, causeIds[1]);
        assertEq(from, 2);
        assertEq(_active(), causeIds[0], "not before the boundary");
        assertEq(gov.activeCauseAt(address(token), t0 + 2 days - 1), causeIds[0]);
        assertEq(gov.activeCauseAt(address(token), t0 + 2 days), causeIds[1]);
        vm.warp(t0 + 2 days);
        assertEq(_active(), causeIds[1]);
    }

    function test_finalize_late_appliesFromNextBoundary() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        vm.warp(t0 + 2 days + 5); // rotation 2 already started
        gov.finalizeRound(address(token), 2);
        (,,,,, uint64 from,) = gov.roundOf(address(token), 2);
        assertEq(from, 3, "never retroactive");
        assertEq(_active(), causeIds[0], "rotation 2 keeps the prior cause");
        vm.warp(t0 + 3 days);
        assertEq(_active(), causeIds[1]);
    }

    function test_finalize_tallyNotFinal_andInvalid() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        vm.expectRevert(IRotationGovernor.TallyNotFinal.selector);
        gov.finalizeRound(address(token), 2);
        // A winner index outside the options.
        scheme.submitOutcome(address(gov), address(token), _rot(2), abi.encode(uint8(3)), "");
        vm.expectRevert(IRotationGovernor.InvalidTally.selector);
        gov.finalizeRound(address(token), 2);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundNotClosed.selector, address(token), 3)
        );
        gov.finalizeRound(address(token), 3);
    }

    function test_finalize_tieGoesToLowestIndex_andZeroCountsNoChange() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 2);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        uint64[] memory tie = new uint64[](3);
        tie[1] = 5;
        tie[2] = 5;
        scheme.submitTally(address(gov), address(token), _rot(2), abi.encode(tie), "");
        gov.finalizeRound(address(token), 2);
        (,,,, bytes32 winner,,) = gov.roundOf(address(token), 2);
        assertEq(winner, causeIds[1]);

        vm.warp(t0 + 2 days + 10);
        _vote(alice, 3, 2);
        vm.warp(_voteEnd(3));
        gov.closeRound(address(token), 3);
        scheme.submitTally(address(gov), address(token), _rot(3), abi.encode(new uint64[](3)), "");
        gov.finalizeRound(address(token), 3);
        assertEq(uint8(_status(3)), uint8(IRotationGovernor.RoundStatus.NoChange));
    }

    function test_finalize_inactiveWinner() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 2);
        // Blocked after the ballot was prepared: the round keeps it, the result does not apply.
        causes.deactivateCause(causeIds[2]);
        _settle(2);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.InactiveWinner));
        vm.warp(t0 + 2 days);
        assertEq(_active(), causeIds[0]);
    }

    function test_finalize_staleAndSupersede() public {
        // Round 2 closes but its tally is late; round 3 runs and is finalized first.
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        vm.warp(t0 + 2 days + 10);
        _vote(alice, 3, 2);
        _settle(3);
        assertEq(gov.causeStateOf(address(token)).lastAppliedTarget, 3);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        gov.finalizeRound(address(token), 2);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.Stale));
        vm.warp(t0 + 3 days);
        assertEq(_active(), causeIds[2]);
    }

    function test_finalize_lateThenOnTime_sameBoundaryOverwritten() public {
        // Round 2's late result targets rotation 3; round 3's on-time result replaces it.
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        vm.warp(t0 + 2 days + 10);
        gov.finalizeRound(address(token), 2);
        _vote(bob, 3, 2);
        _settle(3);
        (,,,,, uint64 from,) = gov.roundOf(address(token), 3);
        assertEq(from, 3);
        vm.warp(t0 + 3 days);
        assertEq(_active(), causeIds[2]);
    }

    function test_finalize_materializesPreviousResult() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        _settle(2);
        vm.warp(t0 + 2 days + 10);
        _vote(alice, 3, 2);
        _settle(3);
        RotationGovernor.CauseState memory cs = gov.causeStateOf(address(token));
        assertEq(cs.current, causeIds[1], "rotation 2 cause folded in");
        assertEq(cs.next, causeIds[2]);
        assertEq(_active(), causeIds[1]);
        vm.warp(t0 + 3 days);
        assertEq(_active(), causeIds[2]);
    }

    // ------------------------------------------------------------------ catalogue ballots

    function test_ballotIsTheFocusPool_andTheSchemeCapsIt() public {
        vm.warp(t0 + 1 days + 10);
        (uint32 v, uint256 pool) = gov.poolOf(address(token), 2);
        assertEq(v, 1);
        assertEq(pool, 3);
        assertEq(gov.ballotSize(), 10);
        vm.mockCall(address(scheme), abi.encodeWithSignature("MAX_OPTIONS()"), abi.encode(uint8(2)));
        assertEq(gov.maxOptions(), 2);
        assertEq(gov.ballotSize(), 2);
        // Two slots for a pool of three: hash draws `drawIndex(token, 2, 1, k, 3)`, repeats
        // skipped, until two distinct causes are drawn.
        IEpochGovernor.Draw[] memory d = new IEpochGovernor.Draw[](6);
        bytes32 first;
        uint256 k;
        for (; k < 6; ++k) {
            uint256 idx = gov.drawIndex(address(token), 2, 1, k, 3);
            assertEq(idx, uint256(keccak256(abi.encode(address(token), 2, uint32(1), k))) % 3);
            d[k] = IEpochGovernor.Draw(poolOrgs[idx], CatalogTree.proof(poolLeaves, idx));
            if (k == 0) first = poolOrgs[idx];
            else if (poolOrgs[idx] != first) break;
        }
        uint256 used = k + 1;
        assembly ("memory-safe") {
            mstore(d, 6)
        }
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TooManyDraws.selector, 6, used));
        gov.prepareRound(address(token), 2, d);
        assembly ("memory-safe") {
            mstore(d, used)
        }
        gov.prepareRound(address(token), 2, d);
        bytes32[] memory orgs = gov.roundOptionOrgIds(address(token), 2);
        assertEq(orgs.length, 2);
        assertEq(orgs[0], first);
        assertEq(orgs[1], d[used - 1].orgId);
    }

    function test_winnerIsMaterialized_andPaidFromTheRegistry() public {
        // A catalogue org that was never added to the registry wins.
        bytes32 newOrg = bytes32(uint256(5000));
        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = newOrg;
        orgs[1] = orgIds[1];
        CauseCatalog c2 = new CauseCatalog(address(this));
        bytes32[] memory leaves = CatalogPublish.publish(c2, orgs);
        RotationGovernor g2 = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ICauseCatalog(address(c2)),
            ITokenProfileRegistry(address(profiles)),
            pm,
            IOutcomeVotingScheme(address(scheme)),
            _params()
        );
        scheme.setGovernor(address(g2), true);
        causes.setMaterializer(address(g2), true);
        g2.setVault(address(this));
        vm.warp(block.timestamp + 1);
        g2.registerToken(address(token), causeIds[0], RotationPeriod.OneDay);
        uint256 start = block.timestamp;
        vm.warp(start + 1 days + 10);
        g2.prepareRound(address(token), 2, CatalogPublish.allDraws(orgs, leaves));
        bytes32 newCause = causes.causeIdOf(newOrg);
        assertFalse(causes.exists(newCause), "not materialized by preparation");
        assertEq(g2.roundOptionOrgIds(address(token), 2)[0], newOrg);
        vm.prank(alice);
        scheme.castBallot(address(g2), address(token), _rot(2), abi.encode(uint8(0)));
        (,, uint40 end,,,,) = g2.roundOf(address(token), 2);
        vm.warp(end);
        g2.closeRound(address(token), 2);
        scheme.finalizeFromBallots(address(g2), address(token), _rot(2));
        g2.finalizeRound(address(token), 2);
        assertTrue(causes.isActive(newCause), "winner materialized");
        vm.warp(start + 2 days);
        (bytes32 active,) = g2.activeCause(address(token));
        assertEq(active, newCause);
    }

    function test_register_poolTooSmall() public {
        VaradaToken t = _newToken();
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, address(t), 0));
        gov.registerToken(address(t), causeIds[0], RotationPeriod.OneDay);
    }

    // ------------------------------------------------------------------ period proposals

    function test_propose_rotationZero_noCirculatingSupply() public {
        // A token registered as it is created (as the factory does) has no supply at start(0) - 1.
        VaradaToken fresh = _newToken();
        _register(address(fresh), RotationPeriod.OneDay);
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(IRotationGovernor.NoCirculatingSupply.selector);
        gov.proposePeriod(address(fresh), RotationPeriod.OneHour);
    }

    function test_propose_quorumExcludesPoolManager_andThreshold() public {
        vm.warp(t0 + 1 days + 10);
        // dave buys before the snapshot of the next rotation, too little for the threshold.
        vm.prank(carol);
        token.transfer(dave, 1e18);
        vm.warp(t0 + 2 days + 10);
        // dave did not hold through the whole hold window, so his weight is zero.
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.BelowProposalThreshold.selector, uint64(0), uint256(150_000_000)
            )
        );
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
        // A day later the window [t0 + 2 days - 1, t0 + 3 days - 1] is covered: weight 1.
        vm.warp(t0 + 3 days + 10);
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.BelowProposalThreshold.selector, uint64(1), uint256(150_000_000)
            )
        );
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.prank(address(0xdead));
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.BelowProposalThreshold.selector, uint64(0), uint256(150_000_000)
            )
        );
        gov.proposePeriod(address(token), RotationPeriod.OneHour);

        vm.prank(carol);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        RotationGovernor.PeriodProposal memory p = gov.getProposal(id);
        // Circulating = 30e9 whole tokens (the pool manager's 70e9 excluded): 10% quorum.
        assertEq(p.quorumWeight, 3e9);
        assertEq(p.snapshot, t0 + 3 days - 1);
        assertEq(p.holdFrom, t0 + 2 days - 1);
        assertEq(p.token, address(token));
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Active));
        assertEq(gov.activeProposalOf(address(token), RotationPeriod.OneHour), id);
    }

    function test_propose_pendingCooldownSamePeriod() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        vm.expectRevert(IRotationGovernor.SamePeriod.selector);
        gov.proposePeriod(address(token), RotationPeriod.OneDay);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        // Same period: one active proposal at a time.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.ProposalPending.selector, id));
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
        // Another period can run side by side.
        vm.prank(bob);
        uint64 other = gov.proposePeriod(address(token), RotationPeriod.OneWeek);
        assertEq(gov.activeProposalOf(address(token), RotationPeriod.OneWeek), other);

        // A defeat starts that period's cooldown only.
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        uint256 until = gov.getProposal(id).end + 7 days;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.CooldownActive.selector, until));
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.prank(bob);
        gov.proposePeriod(address(token), RotationPeriod.TwelveHours);
        vm.warp(until);
        vm.prank(bob);
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
    }

    function test_cancel() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.NotProposer.selector, bob));
        gov.cancelPeriodProposal(id);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.UnknownProposal.selector, 9));
        gov.cancelPeriodProposal(9);
        vm.prank(alice);
        gov.cancelPeriodProposal(id);
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Canceled));
        assertEq(gov.activeProposalOf(address(token), RotationPeriod.OneHour), 0);
        vm.prank(bob);
        vm.expectRevert(IRotationGovernor.VotingClosed.selector);
        scheme.castBallot(address(gov), address(token), _per(id), abi.encode(uint8(1)));
    }

    function test_cancel_afterEnd_notCancelable() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.warp(gov.getProposal(id).end);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.NotCancelable.selector, id, IRotationGovernor.ProposalState.Ended
            )
        );
        gov.cancelPeriodProposal(id);
    }

    function test_proposal_ballotChecks() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        // Wrong token for the scope.
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.InvalidScope.selector, _per(id)));
        gov.authorizeBallot(address(7), _per(id), bob, bytes32(0));
        // Unknown proposal.
        vm.prank(address(scheme));
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.InvalidScope.selector, _per(42)));
        gov.authorizeBallot(address(token), _per(42), bob, bytes32(0));
        _votePeriod(bob, id, true);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.AlreadyVoted.selector, bob));
        scheme.castBallot(address(gov), address(token), _per(id), abi.encode(uint8(1)));
        vm.prank(dave);
        vm.expectRevert(IRotationGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), address(token), _per(id), abi.encode(uint8(1)));
        assertTrue(gov.hasVotedProposal(id, bob));
    }

    function test_proposal_zeroVoters_defeatedAtClose() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.NotClosable.selector, id, IRotationGovernor.ProposalState.Active
            )
        );
        gov.closePeriodProposal(id);
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Defeated));
        assertEq(gov.activeProposalOf(address(token), RotationPeriod.OneHour), 0);
    }

    function test_proposal_defeated_againstOrBelowQuorum() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(bob, id, true); // 9e9 FOR
        _votePeriod(alice, id, false); // 20e9 AGAINST
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        assertFalse(gov.executePeriodProposal(id));
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Defeated));

        vm.warp(block.timestamp + 7 days);
        vm.prank(carol);
        id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(carol, id, true); // 1e9 FOR < 3e9 quorum
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        assertFalse(gov.executePeriodProposal(id));
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Defeated));
    }

    function test_proposal_expiry_withAndWithoutTally() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(alice, id, true);
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        vm.expectRevert(IRotationGovernor.TallyNotFinal.selector);
        gov.executePeriodProposal(id);
        vm.warp(gov.getProposal(id).executionDeadline + 1);
        assertFalse(gov.executePeriodProposal(id));
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Expired));
        assertEq(gov.activeProposalOf(address(token), RotationPeriod.OneHour), 0);

        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(alice, id, true);
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        vm.warp(gov.getProposal(id).executionDeadline + 1);
        assertFalse(gov.executePeriodProposal(id), "passed but late");
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Expired));
        (RotationPeriod cur, bool pending,,) = gov.periodOf(address(token));
        assertEq(uint8(cur), uint8(RotationPeriod.OneDay));
        assertFalse(pending);
    }

    function test_proposal_executesAtNextBoundary_andOverwritesPending() public {
        vm.warp(t0 + 1 days + 10);
        uint64 id = _changePeriod(RotationPeriod.OneHour);
        uint64 c = gov.currentRotation(address(token));
        RotationGovernor.PeriodProposal memory p = gov.getProposal(id);
        assertEq(p.fromRotation, c + 1);
        (RotationPeriod cur, bool pending, RotationPeriod next, uint64 from) =
            gov.periodOf(address(token));
        assertEq(uint8(cur), uint8(RotationPeriod.OneDay), "unchanged within the rotation");
        assertTrue(pending);
        assertEq(uint8(next), uint8(RotationPeriod.OneHour));
        assertEq(from, c + 1);
        uint256 boundary = gov.rotationStart(address(token), c + 1);
        assertEq(boundary, t0 + (c + 1) * 1 days);

        // Still in rotation c (only if the vote ended within it): overwrite the pending change.
        if (block.timestamp < boundary) {
            gov.setParams(
                IRotationGovernor.Params({
                    votingPeriod: 1 hours,
                    executionWindow: 1 hours,
                    cooldown: 0,
                    quorumBps: 1000,
                    proposalThresholdBps: 50
                })
            );
            vm.prank(alice);
            uint64 id2 = gov.proposePeriod(address(token), RotationPeriod.OneWeek);
            _votePeriod(alice, id2, true);
            vm.warp(block.timestamp + 1 hours);
            if (block.timestamp < boundary) {
                gov.closePeriodProposal(id2);
                scheme.finalizeFromBallots(address(gov), address(token), _per(id2));
                assertTrue(gov.executePeriodProposal(id2));
                (,, next, from) = gov.periodOf(address(token));
                assertEq(uint8(next), uint8(RotationPeriod.OneWeek));
                assertEq(from, c + 1, "same boundary");
            }
        }
        vm.warp(boundary);
        assertEq(gov.currentRotation(address(token)), c + 1);
    }

    function test_roundOpenedBeforeChange_keepsStoredTimes() public {
        gov.setParams(
            IRotationGovernor.Params({
                votingPeriod: 1 hours,
                executionWindow: 1 hours,
                cooldown: 0,
                quorumBps: 1000,
                proposalThresholdBps: 50
            })
        );
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        (, uint40 snap, uint40 end,,,,) = gov.roundOf(address(token), 2);
        _changePeriod(RotationPeriod.OneHour);
        (, uint40 snap2, uint40 end2,,,,) = gov.roundOf(address(token), 2);
        assertEq(snap2, snap);
        assertEq(end2, end);
        assertEq(gov.currentRotation(address(token)), 1, "change executed within rotation 1");
        (uint40 ws,, uint40 we) = gov.pollWindow(address(token), 2);
        assertEq(ws, snap, "window of the open round is unchanged by the change");
        assertEq(we, end);
        // The open round still takes ballots; the next round uses the hourly buffer.
        _vote(bob, 2, 1);
        (,, we) = gov.pollWindow(address(token), 3);
        assertEq(we, t0 + 2 days + 1 hours - 15 minutes);
    }

    function test_scopes_doNotCollide() public {
        vm.warp(t0 + 1 days + 10);
        _prep(address(token), 2);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour); // id 1
        vm.prank(alice);
        gov.cancelPeriodProposal(id);
        vm.warp(t0 + 2 days + 10);
        _prep(address(token), 3); // while proposal 1's poll exists
        assertTrue(scheme.isOpen(address(gov), address(token), _rot(2)));
        assertTrue(scheme.isOpen(address(gov), address(token), _rot(3)));
        assertTrue(scheme.isOpen(address(gov), address(token), _per(1)));
        assertTrue(_rot(1) != _per(1));
    }

    function test_params_bounds() public {
        IRotationGovernor.Params memory p = _params();
        p.votingPeriod = 4 minutes;
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setParams(p);
        p = _params();
        p.quorumBps = 5001;
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setParams(p);
        p = _params();
        p.proposalThresholdBps = 1001;
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setParams(p);
        p = _params();
        p.cooldown = 31 days;
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setParams(p);
        vm.prank(alice);
        vm.expectRevert();
        gov.setParams(_params());
    }
}

/// @dev Hourly rotations with an asynchronous tally (FHE decryption takes minutes).
contract RotationGovernorHourlyTest is RotationGovernorBase {
    function setUp() public {
        _baseSetUp(RotationPeriod.OneHour);
    }

    function test_asyncTally_insideBuffer_onTime() public {
        vm.warp(t0 + 1 hours + 60);
        _vote(alice, 2, 1);
        uint40 end = _voteEnd(2);
        assertEq(end, t0 + 2 hours - 15 minutes);
        vm.warp(end);
        gov.closeRound(address(token), 2);
        vm.warp(end + 10 minutes); // decryption and relay
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        gov.finalizeRound(address(token), 2);
        (,,,,, uint64 from,) = gov.roundOf(address(token), 2);
        assertEq(from, 2);
        vm.warp(t0 + 2 hours);
        assertEq(_active(), causeIds[1]);
    }

    function test_asyncTally_outsideBuffer_nextRotation() public {
        vm.warp(t0 + 1 hours + 60);
        _vote(alice, 2, 1);
        uint40 end = _voteEnd(2);
        vm.warp(end);
        gov.closeRound(address(token), 2);
        vm.warp(end + 20 minutes); // past the boundary
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        gov.finalizeRound(address(token), 2);
        (,,,,, uint64 from,) = gov.roundOf(address(token), 2);
        assertEq(from, 3);
        assertEq(_active(), causeIds[0], "rotation 2 keeps the prior cause");
        vm.warp(t0 + 3 hours);
        assertEq(_active(), causeIds[1]);
    }
}

/// @dev The schedule worked example: launch weekly, switch to hourly, then to three days.
contract RotationGovernorWorkedExampleTest is RotationGovernorBase {
    function _params() internal pure override returns (IRotationGovernor.Params memory) {
        return IRotationGovernor.Params({
            votingPeriod: 1 hours,
            executionWindow: 1 hours,
            cooldown: 0,
            quorumBps: 1000,
            proposalThresholdBps: 50
        });
    }

    function setUp() public {
        _baseSetUp(RotationPeriod.OneWeek);
    }

    function _execAt(RotationPeriod p, uint256 at) internal {
        vm.warp(at - 1 hours - 1);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), p);
        _votePeriod(alice, id, true);
        vm.warp(at - 1);
        // Vote end is `at - 1`: close, tally and execute at exactly `at`.
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        vm.warp(at);
        assertTrue(gov.executePeriodProposal(id));
    }

    function test_workedExample() public {
        // t0 + 10 days: change to hourly executes in rotation 1, pending from 2.
        _execAt(RotationPeriod.OneHour, t0 + 864_000);
        assertEq(gov.currentRotation(address(token)), 1);
        (, bool pending, RotationPeriod next, uint64 from) = gov.periodOf(address(token));
        assertTrue(pending);
        assertEq(uint8(next), uint8(RotationPeriod.OneHour));
        assertEq(from, 2);
        uint256 switchAt = gov.rotationStart(address(token), 2);
        assertEq(switchAt, t0 + 1_209_600);

        // Round for target 2 (opened in rotation 1) uses the weekly 6-hour buffer.
        (uint40 snap, uint40 vs, uint40 ve) = gov.pollWindow(address(token), 2);
        assertEq(vs, t0 + 604_800);
        assertEq(ve, t0 + 1_188_000);
        assertEq(snap, t0 + 604_799);

        // Round for target 3 (rotation 2, hourly) uses the 15-minute buffer.
        (snap, vs, ve) = gov.pollWindow(address(token), 3);
        assertEq(vs, t0 + 1_209_600);
        assertEq(ve, t0 + 1_212_300);
        assertEq(snap, t0 + 1_209_599);

        // On-time and late finalization of target 3.
        vm.warp(t0 + 1_209_600 + 60);
        _vote(alice, 3, 1);
        vm.warp(ve);
        gov.closeRound(address(token), 3);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(3));
        uint256 snapId = vm.snapshotState();
        vm.warp(t0 + 1_212_700);
        gov.finalizeRound(address(token), 3);
        (,,,,, uint64 eff,) = gov.roundOf(address(token), 3);
        assertEq(eff, 3, "on time");
        vm.revertToState(snapId);
        vm.warp(t0 + 1_213_500);
        gov.finalizeRound(address(token), 3);
        (,,,,, eff,) = gov.roundOf(address(token), 3);
        assertEq(eff, 4, "late");
        assertEq(_active(), causeIds[0], "rotation 3 keeps the prior cause");

        vm.warp(t0 + 1_214_999);
        assertEq(gov.currentRotation(address(token)), 3);

        // switchAt + 19,800: change to three days executes in rotation 7, pending from 8.
        _execAt(RotationPeriod.ThreeDays, switchAt + 19_800);
        assertEq(gov.currentRotation(address(token)), 7);
        (, pending, next, from) = gov.periodOf(address(token));
        assertEq(from, 8);
        uint256 switchAt2 = gov.rotationStart(address(token), 8);
        assertEq(switchAt2, t0 + 1_231_200);

        vm.warp(switchAt2 + 360_000);
        assertEq(gov.currentRotation(address(token)), 9);
        assertEq(gov.rotationStart(address(token), 9), t0 + 1_490_400);
        assertEq(gov.rotationStart(address(token), 10), t0 + 1_749_600);
        // A naive (t - t0) / 3 days would give 6, an index used in the hourly segment.
        assertEq((block.timestamp - t0) / 3 days, 6);
    }
}
