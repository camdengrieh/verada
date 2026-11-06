// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IOutcomeVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {RotationGovernorBase} from "./RotationGovernor.t.sol";

/// @dev Audit regressions for the rotation governor:
///      - polls reveal only their outcome, and polls below `minVoters` are never decrypted;
///      - a holder cannot block period changes by occupying the single proposal slot and
///        canceling (cancel starts no cooldown, proposals run per period, no cancel after a
///        ballot, executions supersede older proposals);
///      - a position held only around the public snapshot instant carries no weight.
///      Fixture: daily rotations, holders since a week before registration (`t0`).
contract RotationGovernorAuditTest is RotationGovernorBase {
    function setUp() public {
        _baseSetUp(RotationPeriod.OneDay);
    }

    // ------------------------------------------------------------------ outcome-only reveal

    function test_closeRound_requestsOutcomeOnly() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        _vote(bob, 2, 2);
        vm.warp(_voteEnd(2));
        vm.expectEmit(address(scheme));
        emit IOutcomeVotingScheme.OutcomeRequested(address(gov), address(token), _rot(2), 1);
        gov.closeRound(address(token), 2);
        scheme.finalizeFromBallots(address(gov), address(token), _rot(2));
        gov.finalizeRound(address(token), 2);
        (IRotationGovernor.RoundStatus st,,,, bytes32 winner,,) = gov.roundOf(address(token), 2);
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Applied));
        assertEq(winner, causeIds[1], "the plurality option");
    }

    function test_finalizeRound_noWinnerIsNoChange() public {
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        scheme.submitOutcome(address(gov), address(token), _rot(2), abi.encode(uint8(255)), "");
        gov.finalizeRound(address(token), 2);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.NoChange));
    }

    function test_minVoters_roundBelowIsNeverDecrypted() public {
        gov.setMinVoters(2);
        vm.warp(t0 + 1 days + 10);
        _vote(alice, 2, 1);
        vm.warp(_voteEnd(2));
        gov.closeRound(address(token), 2);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.NoChange));
        assertFalse(scheme.isClosed(address(gov), address(token), _rot(2)), "not decrypted");

        vm.warp(t0 + 2 days + 10);
        _vote(alice, 3, 1);
        _vote(carol, 3, 2);
        _settle(3);
        assertEq(uint8(_status(3)), uint8(IRotationGovernor.RoundStatus.Applied));
    }

    function test_minVoters_proposalBelowIsDefeatedUndecrypted() public {
        gov.setMinVoters(2);
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(alice, id, true);
        vm.warp(gov.getProposal(id).end);
        vm.expectEmit(address(gov));
        emit IRotationGovernor.PeriodProposalTallied(id, false);
        gov.closePeriodProposal(id);
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Defeated));
        assertFalse(scheme.isClosed(address(gov), address(token), _per(id)), "not decrypted");
    }

    function test_setMinVoters_boundsAndOwner() public {
        assertEq(gov.minVoters(), 1);
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setMinVoters(0);
        vm.expectRevert(IRotationGovernor.InvalidParams.selector);
        gov.setMinVoters(101);
        vm.expectEmit(address(gov));
        emit IRotationGovernor.MinVotersSet(5);
        gov.setMinVoters(5);
        assertEq(gov.minVoters(), 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setMinVoters(2);
    }

    function test_periodProposal_outcomeCarriesTheQuorum() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(alice, id, true); // 20e9 FOR
        _votePeriod(bob, id, false); // 9e9 AGAINST
        vm.warp(gov.getProposal(id).end);
        uint64 quorum = gov.getProposal(id).quorumWeight;
        vm.expectEmit(address(scheme));
        emit IOutcomeVotingScheme.OutcomeRequested(address(gov), address(token), _per(id), quorum);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        vm.expectEmit(address(gov));
        emit IRotationGovernor.PeriodProposalTallied(id, true);
        assertTrue(gov.executePeriodProposal(id));
    }

    function test_periodProposal_forWinsBelowQuorumIsDefeated() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(carol);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(carol, id, true); // 1e9 FOR, quorum 3e9
        vm.warp(gov.getProposal(id).end);
        gov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(gov), address(token), _per(id));
        assertFalse(gov.executePeriodProposal(id));
        assertEq(uint8(gov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Defeated));
    }

    // ------------------------------------------------------------------ proposal griefing

    /// @dev The attack: propose and cancel in the same block to lock the token for
    ///      `votingPeriod + cooldown`. Canceling now starts no cooldown.
    function test_proposeAndCancel_doesNotLockTheToken() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(carol);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneWeek);
        vm.prank(carol);
        gov.cancelPeriodProposal(id);
        assertEq(gov.lastProposalEnd(address(token), RotationPeriod.OneWeek), 0);
        vm.prank(alice);
        uint64 honest = gov.proposePeriod(address(token), RotationPeriod.OneWeek);
        assertEq(uint8(gov.proposalState(honest)), uint8(IRotationGovernor.ProposalState.Active));
    }

    /// @dev A front-run proposal for another period does not take the honest proposal's slot.
    function test_occupiedSlot_doesNotBlockOtherPeriods() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(carol);
        uint64 grief = gov.proposePeriod(address(token), RotationPeriod.ThreeDays);
        vm.prank(alice);
        uint64 honest = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        assertTrue(grief != honest);
        _votePeriod(alice, honest, true);
        vm.warp(gov.getProposal(honest).end);
        gov.closePeriodProposal(honest);
        scheme.finalizeFromBallots(address(gov), address(token), _per(honest));
        assertTrue(gov.executePeriodProposal(honest));
    }

    /// @dev Once a proposal has a ballot, its proposer cannot cancel it to reset the vote.
    function test_cancel_afterBallot_reverts() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(carol);
        uint64 id = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        _votePeriod(alice, id, true);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.ProposalHasBallots.selector, id));
        gov.cancelPeriodProposal(id);
    }

    /// @dev Two proposals pass side by side; the first executed supersedes the other, and an
    ///      execution starts the cooldown of every period.
    function test_execution_supersedesOlderProposals_andStartsTokenCooldown() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        uint64 a = gov.proposePeriod(address(token), RotationPeriod.OneHour);
        vm.prank(bob);
        uint64 b = gov.proposePeriod(address(token), RotationPeriod.OneWeek);
        _votePeriod(alice, a, true);
        _votePeriod(alice, b, true);
        uint256 end = gov.getProposal(b).end;
        vm.warp(end);
        gov.closePeriodProposal(a);
        gov.closePeriodProposal(b);
        scheme.finalizeFromBallots(address(gov), address(token), _per(a));
        scheme.finalizeFromBallots(address(gov), address(token), _per(b));
        assertTrue(gov.executePeriodProposal(a));
        assertFalse(gov.executePeriodProposal(b), "superseded");
        assertEq(uint8(gov.proposalState(b)), uint8(IRotationGovernor.ProposalState.Expired));
        (,, RotationPeriod next,) = gov.periodOf(address(token));
        assertEq(uint8(next), uint8(RotationPeriod.OneHour));

        uint256 until = gov.getProposal(a).end + 7 days;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.CooldownActive.selector, until));
        gov.proposePeriod(address(token), RotationPeriod.TwelveHours);
    }

    // ------------------------------------------------------------------ snapshot timing

    /// @dev dave borrows 10% of the supply for the block before the round's public snapshot
    ///      (`start(2) - 1`) and returns it right after. The single-instant weight would have
    ///      been 10e9; the hold weight is zero.
    function test_oneBlockHoldAroundSnapshot_hasNoWeight() public {
        uint256 snapshot = t0 + 2 days - 1;
        vm.warp(snapshot);
        vm.prank(alice);
        token.transfer(dave, 10e9 * 1e18);
        vm.warp(snapshot + 1);
        vm.prank(dave);
        token.transfer(alice, 10e9 * 1e18);
        vm.warp(snapshot + 100);
        assertEq(gov.weightAt(address(token), snapshot, dave), 10e9, "single-instant weight");
        assertEq(gov.holdWeightAt(address(token), snapshot - 1 days, snapshot, dave), 0);
        _prep(address(token), 3);
        vm.prank(dave);
        vm.expectRevert(IRotationGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), address(token), _rot(3), abi.encode(uint8(1)));
        (uint40 holdFrom, uint40 snap) = gov.roundHoldWindow(address(token), 3);
        assertEq(snap, snapshot);
        assertEq(holdFrom, snapshot - 1 days);

        // The same position cannot propose or pass a period change either.
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRotationGovernor.BelowProposalThreshold.selector, uint64(0), uint256(150_000_000)
            )
        );
        gov.proposePeriod(address(token), RotationPeriod.OneHour);
    }

    /// @dev A dip inside the hold window lowers the weight to the lowest balance held.
    function test_dipInsideWindow_lowersWeight() public {
        vm.warp(t0 + 1 days + 100);
        vm.prank(bob);
        token.transfer(carol, 5e9 * 1e18);
        vm.warp(t0 + 1 days + 200);
        vm.prank(carol);
        token.transfer(bob, 5e9 * 1e18);
        vm.warp(t0 + 2 days + 10);
        _vote(bob, 3, 2);
        assertEq(scheme.liveCounts(address(gov), address(token), _rot(3))[2], 4e9, "9e9 - 5e9");
        _vote(carol, 3, 1);
        assertEq(scheme.liveCounts(address(gov), address(token), _rot(3))[1], 1e9, "carol's own");
    }

    /// @dev Many checkpoints inside the window keep a ballot's cost bounded.
    function test_manyCheckpoints_boundedScan() public {
        uint256 start = t0 + 1 days + 10;
        for (uint256 i; i < 200; ++i) {
            vm.warp(start + i);
            vm.prank(bob);
            token.transfer(carol, 1e18);
        }
        vm.warp(t0 + 2 days + 10);
        uint256 g = gasleft();
        _vote(bob, 3, 2);
        uint256 used = g - gasleft();
        assertLt(used, 1_500_000, "bounded");
        assertEq(scheme.liveCounts(address(gov), address(token), _rot(3))[2], 9e9 - 200);
    }

    function test_holdWindow_followsThePeriod() public {
        _changePeriod(RotationPeriod.OneWeek); // from rotation 2 on, weekly
        uint256 s2 = gov.rotationStart(address(token), 2);
        vm.warp(s2 + 10);
        _prep(address(token), 3); // voted during the weekly rotation 2
        (uint40 holdFrom, uint40 snap) = gov.roundHoldWindow(address(token), 3);
        assertEq(snap, s2 - 1);
        assertEq(holdFrom, s2 - 1 - 7 days, "a full weekly rotation");
        RotationGovernor.PeriodProposal memory p = gov.getProposal(1);
        assertEq(p.holdFrom, p.snapshot - 1 days, "a daily proposal looks back one day");
    }
}
