// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IOutcomeVotingScheme, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {RotationScheduleLib} from "../../src/libraries/RotationScheduleLib.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";

/// @dev Drives a live token's holders through transfers, rotation polls (prepare, vote, close,
///      tally, finalize, sometimes late) and period proposals, recording what the governor did.
contract RotationHandler is Test {
    RotationGovernor public gov;
    MockVotingScheme public scheme;
    VeradaToken public token;
    address[] public voters;

    // Poll bookkeeping (rotation polls and proposals share the scope space).
    uint256[] public scopes;
    mapping(uint256 scope => bool) public scopeTouched;
    mapping(uint256 scope => uint256) public authorizedWeight;
    mapping(uint256 scope => uint256) public ballots;
    mapping(uint256 scope => uint256) public snapshotOf;
    mapping(uint256 scope => uint256) public openedAt;
    mapping(uint256 scope => mapping(address voter => bool)) public voted;

    // Cause and schedule bookkeeping.
    mapping(bytes32 cause => bool) public allowedCause; // initial cause and applied winners
    mapping(uint64 rotation => bytes32) public causeSeen; // first observed cause per rotation
    mapping(uint64 rotation => bool) public rotationSeen;
    uint64 public lastIndex;
    uint64 public lastApplied;
    uint256 public appliedRounds;
    uint256 public badEffectiveFrom;
    uint256 public executedChanges;
    /// @dev Latest proposal the handler created (the one it votes on and settles).
    uint64 public pendingId;
    /// @dev The token's focus pool and its catalogue leaves (rounds are prepared from them).
    bytes32[] internal _poolOrgs;
    bytes32[] internal _poolLeaves;

    constructor(
        RotationGovernor gov_,
        MockVotingScheme scheme_,
        VeradaToken token_,
        address[] memory voters_,
        bytes32 initialCause,
        bytes32[] memory poolOrgs_,
        bytes32[] memory poolLeaves_
    ) {
        gov = gov_;
        scheme = scheme_;
        token = token_;
        voters = voters_;
        _poolOrgs = poolOrgs_;
        _poolLeaves = poolLeaves_;
        allowedCause[initialCause] = true;
        _observe();
    }

    function scopeCount() external view returns (uint256) {
        return scopes.length;
    }

    function voterCount() external view returns (uint256) {
        return voters.length;
    }

    // ---- observation (called after every action)

    function _observe() internal {
        (bytes32 cause, uint64 idx) = gov.activeCause(address(token));
        assertGe(idx, lastIndex, "G1 index non-decreasing");
        lastIndex = idx;
        if (!rotationSeen[idx]) {
            rotationSeen[idx] = true;
            causeSeen[idx] = cause;
        } else {
            assertEq(cause, causeSeen[idx], "G3 cause of a started rotation never changes");
        }
        assertTrue(allowedCause[cause], "G4 initial cause or applied winner");
    }

    function _touch(uint256 scope, uint256 snapshot) internal {
        if (scopeTouched[scope]) return;
        scopeTouched[scope] = true;
        scopes.push(scope);
        snapshotOf[scope] = snapshot;
        openedAt[scope] = block.timestamp;
    }

    // ---- actions

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(uint256(by), 1, 30 hours));
        _observe();
    }

    function transfer(uint8 fromSeed, uint8 toSeed, uint96 amount) external {
        address from = voters[fromSeed % voters.length];
        address to = voters[toSeed % voters.length];
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        vm.prank(from);
        token.transfer(to, bound(uint256(amount), 1, bal));
        _observe();
    }

    function voteRound(uint8 voterSeed, uint8 choice) external {
        address voter = voters[voterSeed % voters.length];
        uint64 target = gov.currentRotation(address(token)) + 1;
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
        _prepare(target);
        vm.prank(voter);
        try scheme.castBallot(address(gov), address(token), scope, abi.encode(uint8(choice % 3))) {
            (uint40 holdFrom, uint40 snap) = gov.roundHoldWindow(address(token), target);
            _touch(scope, snap);
            assertFalse(voted[scope][voter], "G5 one ballot per voter");
            voted[scope][voter] = true;
            ++ballots[scope];
            uint64 w = gov.holdWeightAt(address(token), holdFrom, snap, voter);
            assertLe(w, gov.weightAt(address(token), snap, voter), "G5 hold weight <= snapshot");
            authorizedWeight[scope] += w;
        } catch {}
        _observe();
    }

    /// @dev Prepares round `target` as a keeper would, if nobody did.
    function _prepare(uint64 target) internal {
        (IRotationGovernor.RoundStatus st,,,,,,) = gov.roundOf(address(token), target);
        if (st != IRotationGovernor.RoundStatus.None) return;
        IEpochGovernor.Draw[] memory d = CatalogPublish.allDraws(_poolOrgs, _poolLeaves);
        try gov.prepareRound(address(token), target, d) {} catch {}
    }

    function settleRound(uint8 lateSeed) external {
        uint64 target = gov.currentRotation(address(token)) + 1;
        (IRotationGovernor.RoundStatus st,, uint40 voteEnd,,,,) =
            gov.roundOf(address(token), target);
        if (st != IRotationGovernor.RoundStatus.Open) return;
        if (block.timestamp < voteEnd) vm.warp(voteEnd);
        gov.closeRound(address(token), target);
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
        (st,,,,,,) = gov.roundOf(address(token), target);
        if (st != IRotationGovernor.RoundStatus.Closed) {
            _observe();
            return;
        }
        scheme.finalizeFromBallots(address(gov), address(token), scope);
        // Sometimes the tally lands after the boundary (slow decryption).
        if (lateSeed % 3 == 0) vm.warp(gov.rotationStart(address(token), target) + 30 minutes);
        _finalize(target);
        _observe();
    }

    function _finalize(uint64 target) internal {
        uint64 c = gov.currentRotation(address(token));
        gov.finalizeRound(address(token), target);
        (IRotationGovernor.RoundStatus st,,,, bytes32 winner, uint64 from,) =
            gov.roundOf(address(token), target);
        if (st == IRotationGovernor.RoundStatus.Applied) {
            ++appliedRounds;
            allowedCause[winner] = true;
            if (from < c + 1) ++badEffectiveFrom;
            assertGt(target, lastApplied, "G8 monotonic");
            lastApplied = target;
        }
    }

    function propose(uint8 voterSeed, uint8 periodSeed) external {
        address voter = voters[voterSeed % voters.length];
        vm.prank(voter);
        try gov.proposePeriod(address(token), RotationPeriod(periodSeed % 5)) returns (uint64 id) {
            _touch(PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id), gov.getProposal(id).snapshot);
            pendingId = id;
        } catch {}
        _observe();
    }

    function _pending() internal view returns (uint64 id) {
        id = pendingId;
        if (id == 0) return 0;
        IRotationGovernor.ProposalState st = gov.proposalState(id);
        if (
            st != IRotationGovernor.ProposalState.Active
                && st != IRotationGovernor.ProposalState.Ended
                && st != IRotationGovernor.ProposalState.Closed
        ) return 0;
    }

    function voteProposal(uint8 voterSeed, bool support) external {
        uint64 id = _pending();
        if (id == 0) return;
        address voter = voters[voterSeed % voters.length];
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id);
        vm.prank(voter);
        try scheme.castBallot(
            address(gov), address(token), scope, abi.encode(uint8(support ? 1 : 0))
        ) {
            assertFalse(voted[scope][voter], "G5 one ballot per voter");
            voted[scope][voter] = true;
            ++ballots[scope];
            RotationGovernor.PeriodProposal memory p = gov.getProposal(id);
            authorizedWeight[
                scope
            ] += gov.holdWeightAt(address(token), p.holdFrom, p.snapshot, voter);
        } catch {}
        _observe();
    }

    function settleProposal() external {
        uint64 id = _pending();
        if (id == 0) return;
        RotationGovernor.PeriodProposal memory p = gov.getProposal(id);
        if (block.timestamp < p.end) vm.warp(p.end);
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id);
        if (gov.proposalState(id) == IRotationGovernor.ProposalState.Ended) {
            gov.closePeriodProposal(id);
        }
        if (gov.proposalState(id) == IRotationGovernor.ProposalState.Closed) {
            scheme.finalizeFromBallots(address(gov), address(token), scope);
            if (gov.executePeriodProposal(id)) ++executedChanges;
        }
        _observe();
    }
}

contract RotationInvariantsTest is Test {
    RotationHandler internal handler;
    RotationGovernor internal gov;
    MockVotingScheme internal scheme;
    VeradaToken internal token;
    address[] internal voters;

    function setUp() public {
        vm.warp(1_700_000_000);
        MockUSDC usdc = new MockUSDC();
        MockOrgFactory endFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), address(1)));
        CauseRegistry causes =
            new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(endFactory)));
        bytes32[] memory list = new bytes32[](3);
        bytes32[] memory orgs = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            orgs[i] = bytes32(uint256(500 + i));
            list[i] = causes.causeIdOf(orgs[i]);
            causes.addCause(list[i], orgs[i], endFactory.computeOrgAddress(orgs[i]), "");
        }
        CauseCatalog catalog = new CauseCatalog(address(this));
        bytes32[] memory leaves = CatalogPublish.publish(catalog, orgs);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        scheme = new MockVotingScheme();
        gov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ICauseCatalog(address(catalog)),
            ITokenProfileRegistry(address(profiles)),
            makeAddr("pm"),
            IOutcomeVotingScheme(address(scheme)),
            IRotationGovernor.Params({
                votingPeriod: 1 hours,
                executionWindow: 2 hours,
                cooldown: 0,
                quorumBps: 1000,
                proposalThresholdBps: 50
            })
        );
        scheme.setGovernor(address(gov), true);
        causes.setMaterializer(address(gov), true);
        gov.setVault(address(this));

        token = new VeradaToken("T", "T", "", address(this), address(this));
        voters.push(makeAddr("v0"));
        voters.push(makeAddr("v1"));
        voters.push(makeAddr("v2"));
        voters.push(makeAddr("v3"));
        token.transfer(makeAddr("pm"), token.totalSupply() / 2);
        uint256 share = token.balanceOf(address(this)) / 4;
        for (uint256 i; i < 4; ++i) {
            token.transfer(voters[i], share);
        }
        // Holders hold for longer than any hold window (up to a week) before registration.
        vm.warp(block.timestamp + 8 days);
        profiles.setFocus(address(token), CatalogPublish.CATEGORIES, CatalogPublish.REGIONS);
        gov.registerToken(address(token), list[0], RotationPeriod.OneHour);

        handler = new RotationHandler(gov, scheme, token, voters, list[0], orgs, leaves);
        targetContract(address(handler));
    }

    /// @dev Smoke test: the handler reaches applied rounds and executed period changes.
    function test_handlerReachesEveryPath() public {
        handler.warp(3700); // rotation 1: snapshots now postdate the distribution
        handler.voteRound(0, 1);
        handler.voteRound(1, 2);
        handler.settleRound(1);
        assertEq(handler.appliedRounds(), 1);
        handler.propose(0, 4);
        handler.voteProposal(0, true);
        handler.voteProposal(1, true);
        handler.settleProposal();
        assertEq(handler.executedChanges(), 1);
        uint64 c = gov.currentRotation(address(token));
        handler.warp(uint32(gov.rotationStart(address(token), c + 1) + 60 - block.timestamp));
        handler.voteRound(2, 0);
        handler.settleRound(0); // late tally
        assertEq(handler.appliedRounds(), 2);
        assertEq(handler.badEffectiveFrom(), 0);
    }

    /// G1, G7: the current rotation lies within its bounds and has the length of its period.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_scheduleBounds() public view {
        uint64 c = gov.currentRotation(address(token));
        uint256 s = gov.rotationStart(address(token), c);
        uint256 e = gov.rotationStart(address(token), c + 1);
        assertLe(s, block.timestamp);
        assertGt(e, block.timestamp);
        (RotationPeriod cur,,,) = gov.periodOf(address(token));
        assertEq(e - s, RotationScheduleLib.length(cur));
    }

    /// G5: one ballot per voter per poll; the scheme, governor and handler agree; the authorized
    /// weight is bounded by the past supply and the snapshot precedes the poll's opening.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_ballots() public view {
        uint256 n = handler.scopeCount();
        for (uint256 i; i < n; ++i) {
            uint256 scope = handler.scopes(i);
            uint256 counted;
            for (uint256 v; v < voters.length; ++v) {
                bool voted = handler.voted(scope, voters[v]);
                assertEq(scheme.hasVoted(address(gov), address(token), scope, voters[v]), voted);
                if (voted) ++counted;
            }
            assertEq(counted, handler.ballots(scope));
            assertEq(scheme.ballotCount(address(gov), address(token), scope), counted);
            uint256 snap = handler.snapshotOf(scope);
            assertLt(snap, handler.openedAt(scope), "snapshot before the poll opens");
            assertLe(handler.authorizedWeight(scope), token.getPastTotalSupply(snap) / 1e18);
        }
    }

    /// G8: applied results never take effect in a rotation that already started.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_neverRetroactive() public view {
        assertEq(handler.badEffectiveFrom(), 0);
        assertEq(gov.causeStateOf(address(token)).lastAppliedTarget, handler.lastApplied());
    }

    /// At most one active proposal per period, and it is the one the governor reports.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 120
    function invariant_onePendingProposalPerPeriod() public view {
        uint64 count = gov.proposalCount();
        uint256[5] memory pending;
        for (uint64 id = 1; id <= count; ++id) {
            IRotationGovernor.ProposalState s = gov.proposalState(id);
            RotationPeriod period = gov.getProposal(id).newPeriod;
            if (
                s == IRotationGovernor.ProposalState.Active
                    || s == IRotationGovernor.ProposalState.Ended
                    || s == IRotationGovernor.ProposalState.Closed
            ) {
                ++pending[uint8(period)];
                assertEq(gov.activeProposalOf(address(token), period), id);
            }
        }
        for (uint256 i; i < 5; ++i) {
            assertLe(pending[i], 1);
        }
    }
}
