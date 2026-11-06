// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TakeoverGovernor} from "../src/TakeoverGovernor.sol";
import {VaradaToken} from "../src/VaradaToken.sol";
import {ITakeoverGovernor} from "../src/interfaces/ITakeoverGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {HoldWeightLib} from "../src/libraries/HoldWeightLib.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";

/// @notice Regressions for the takeover governor: snapshot-only voting power, proposal slots that
///         one holder cannot monopolise, and quorum measured against the circulating supply.
contract TakeoverGovernorHardeningTest is Test {
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant WHOLE = 1e18;
    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;

    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    TakeoverGovernor internal gov;
    VaradaToken internal tokenContract;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal proposer = makeAddr("proposer");
    address internal whale = makeAddr("whale");
    address internal mid = makeAddr("mid");
    address internal nobody = makeAddr("nobody");
    address internal newController = makeAddr("newController");
    address internal poolManager = makeAddr("poolManager");

    ITakeoverGovernor.Params internal P = ITakeoverGovernor.Params({
        votingPeriod: 3 days,
        executionWindow: 7 days,
        cooldown: 14 days,
        minTokenAge: 2 days,
        quorumBps: 1000,
        proposalThresholdBps: 100,
        lookback: 1 days
    });

    function setUp() public {
        vm.warp(T0);
        tokenContract = new VaradaToken("Varada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(tokenContract);
        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        profiles.register(token, creator);
        gov = new TakeoverGovernor(
            owner, ITokenProfileRegistry(address(profiles)), scheme, P, poolManager
        );
        scheme.setGovernor(address(gov), true);
        profiles.setGovernor(address(gov));
    }

    // ---- helpers

    function _give(address to, uint256 amount) internal {
        vm.prank(factory);
        tokenContract.transfer(to, amount);
    }

    /// @dev Standard distribution: proposer 2%, whale 10%, mid 5%; the rest stays with the factory.
    function _distribute() internal {
        _give(proposer, 2_000_000_000 * WHOLE);
        _give(whale, 10_000_000_000 * WHOLE);
        _give(mid, 5_000_000_000 * WHOLE);
        vm.warp(T0 + 2 days);
    }

    function _vote(uint256 id, address voter, uint8 choice) internal {
        vm.prank(voter);
        scheme.castBallot(address(gov), token, id, abi.encode(choice));
    }

    function _assertState(uint256 id, ITakeoverGovernor.State s) internal view {
        assertEq(uint8(gov.state(id)), uint8(s));
    }

    // ---- voting power must be held through the lookback, not bought for the vote

    /// Buy, propose and vote in the following blocks, then sell: the bought votes weigh nothing
    /// until they have been held for the full lookback, and count in full one second later.
    function test_voteRental_lookbackEdge() public {
        _distribute();
        address attacker = makeAddr("attacker");
        uint256 boughtAt = block.timestamp;
        _give(attacker, 15_000_000_000 * WHOLE); // 15%: above quorum on its own

        // Next block: the attacker cannot propose with the fresh balance...
        vm.warp(boughtAt + 12);
        // No pool balance here, so the circulating supply is the total supply.
        uint64 required = uint64((tokenContract.totalSupply() / WHOLE) * 100 / 10_000);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, attacker);

        // ...nor vote on an honest proposal opened in that block.
        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        assertEq(gov.weightOf(id, attacker), 0);
        vm.prank(attacker);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));

        // Selling afterwards changes nothing for the running proposal.
        vm.prank(attacker);
        tokenContract.transfer(nobody, 15_000_000_000 * WHOLE);
        assertEq(gov.weightOf(id, attacker), 0);
        assertEq(gov.weightOf(id, nobody), 0);

        // Edge: with the balance bought at `boughtAt`, a proposal at `boughtAt + lookback` reads
        // the lookback checkpoint one second before the purchase; one second later it counts.
        address holder = makeAddr("holder");
        uint256 heldFrom = block.timestamp;
        _give(holder, 3_000_000_000 * WHOLE);
        vm.warp(heldFrom + P.lookback);
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, newController);
        vm.warp(heldFrom + P.lookback + 1);
        vm.prank(holder);
        uint256 id2 = gov.propose(token, newController);
        assertEq(gov.weightOf(id2, holder), 3_000_000_000);
    }

    /// Audit #9: a balance held at the lookback snapshot and at the snapshot, but lent out in
    /// between, used to count in full (the weight read those two instants only). The weight is now
    /// the lowest checkpoint over the whole lookback, so it is zero.
    function test_holdOnlyAtBothInstants_hasNoWeight() public {
        _distribute();
        address attacker = makeAddr("attacker");
        // A constant, not `block.timestamp`: via_ir may re-read the timestamp after a warp.
        uint256 boughtAt = T0 + 2 days;
        _give(attacker, 15_000_000_000 * WHOLE); // 15%: above quorum on its own
        vm.warp(boughtAt + 1 hours);
        vm.prank(attacker);
        assertTrue(tokenContract.transfer(nobody, 15_000_000_000 * WHOLE));
        vm.warp(boughtAt + 23 hours);
        vm.prank(nobody);
        assertTrue(tokenContract.transfer(attacker, 15_000_000_000 * WHOLE));

        // Proposals now read the snapshot `boughtAt + lookback` and the lookback `boughtAt`,
        // both with the full balance.
        vm.warp(boughtAt + P.lookback + 1);
        uint64 required = uint64((tokenContract.totalSupply() / WHOLE) * 100 / 10_000);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, required)
        );
        gov.propose(token, attacker);

        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        assertEq(gov.getProposal(id).lookbackSnapshot, boughtAt);
        assertEq(gov.weightOf(id, attacker), 0);
        assertEq(gov.weightOf(id, nobody), 0);
        assertEq(gov.weightOf(id, whale), 10_000_000_000, "held all along");
        vm.prank(attacker);
        vm.expectRevert(ITakeoverGovernor.InvalidVote.selector);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
    }

    /// A partial sale inside the lookback lowers the weight to the balance kept.
    function test_dipInsideLookback_lowersWeight() public {
        _distribute();
        uint256 at = T0 + 2 days;
        vm.prank(whale);
        assertTrue(tokenContract.transfer(nobody, 6_000_000_000 * WHOLE));
        vm.warp(at + 1 hours);
        vm.prank(nobody);
        assertTrue(tokenContract.transfer(whale, 6_000_000_000 * WHOLE));
        vm.warp(at + 12 hours);
        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        assertEq(gov.weightOf(id, whale), 4_000_000_000);
        vm.prank(whale);
        scheme.castBallot(address(gov), token, id, abi.encode(FOR));
        assertEq(scheme.liveCounts(address(gov), token, id)[FOR], 4_000_000_000);
    }

    /// Dust sent to a voter cannot block its ballot: anyone runs the scan ahead in chunks and the
    /// weight is unchanged.
    function test_advanceHoldScan_dustCannotBlockTheBallot() public {
        _distribute();
        uint256 at = T0 + 2 days;
        for (uint256 i; i < 300; ++i) {
            vm.warp(at + 10 + i);
            vm.prank(mid);
            assertTrue(tokenContract.transfer(whale, 1));
        }
        vm.warp(at + P.lookback + 5); // the window starts before the dust
        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);

        vm.expectRevert(abi.encodeWithSelector(ITakeoverGovernor.UnknownProposal.selector, 99));
        gov.advanceHoldScan(99, whale, 10);
        vm.prank(nobody);
        assertFalse(gov.advanceHoldScan(id, whale, 100));
        assertTrue(gov.advanceHoldScan(id, whale, 250));
        uint256 g = gasleft();
        assertEq(gov.weightOf(id, whale), 10_000_000_000);
        assertLt(g - gasleft(), 30_000, "cached");
        _vote(id, whale, AGAINST);
        assertEq(scheme.liveCounts(address(gov), token, id)[AGAINST], 10_000_000_000);
    }

    // ---- proposal slots: a holder cannot keep others out, and proposing needs a stake

    /// A holder at the threshold who proposes again after every cooldown never blocks anyone
    /// else: other holders can propose while that proposal runs and during its cooldown.
    function test_repeatProposer_doesNotHoldTheSlot() public {
        _distribute();
        address junk = makeAddr("junk");
        // Tracked explicitly: under via-IR `block.timestamp` may be cached across warps.
        uint256 t = T0 + 2 days;
        for (uint256 round; round < 3; ++round) {
            vm.prank(proposer);
            uint256 griefId = gov.propose(token, junk);
            _assertState(griefId, ITakeoverGovernor.State.Active);

            // Another holder proposes while the griefer's proposal is active.
            address other = makeAddr(string(abi.encodePacked("other", round)));
            _give(other, 1_000_000_000 * WHOLE);
            t += 1 days + 1;
            vm.warp(t);
            vm.prank(other);
            uint256 otherId = gov.propose(token, newController);
            _assertState(otherId, ITakeoverGovernor.State.Active);

            // The griefer itself is limited to one pending proposal and its own cooldown.
            vm.prank(proposer);
            vm.expectRevert(
                abi.encodeWithSelector(ITakeoverGovernor.ProposalPending.selector, token, griefId)
            );
            gov.propose(token, junk);

            // Past the vote and the griefer's cooldown, the next round starts.
            t = uint256(gov.getProposal(griefId).end) + P.cooldown;
            vm.warp(t);
        }
    }

    /// A zero proposal threshold is rejected: proposing must always take a stake in the token.
    function test_params_rejectZeroProposalThreshold() public {
        ITakeoverGovernor.Params memory q = P;
        q.proposalThresholdBps = 0;
        vm.prank(owner);
        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        gov.setParams(q);

        vm.expectRevert(ITakeoverGovernor.InvalidParams.selector);
        new TakeoverGovernor(
            owner, ITokenProfileRegistry(address(profiles)), scheme, q, poolManager
        );

        q.proposalThresholdBps = gov.MIN_PROPOSAL_THRESHOLD_BPS();
        vm.prank(owner);
        gov.setParams(q);
        assertEq(gov.params().proposalThresholdBps, 1);
    }

    /// With almost the whole supply in the pool, 1 bps of the circulating supply rounds down to
    /// zero tokens; an account holding nothing still cannot propose, while a one-token holder can.
    function test_propose_zeroWeightRejected_whenThresholdRoundsToZero() public {
        ITakeoverGovernor.Params memory q = P;
        q.proposalThresholdBps = 1;
        vm.prank(owner);
        gov.setParams(q);

        address holder = makeAddr("holder");
        _give(holder, 10 * WHOLE);
        _give(mid, 4000 * WHOLE);
        uint256 rest = tokenContract.balanceOf(factory);
        vm.prank(factory);
        tokenContract.transfer(poolManager, rest);
        vm.warp(T0 + 2 days);

        // Circulating: 4010 whole tokens; 1 bps of it is 0.
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(ITakeoverGovernor.BelowProposalThreshold.selector, 0, 1)
        );
        gov.propose(token, nobody);

        vm.prank(holder);
        uint256 id = gov.propose(token, newController);
        assertEq(gov.getProposal(id).circulatingWeight, 4010);
    }

    // ---- quorum is measured against the circulating supply

    /// Pool flows in the proposing block cannot move quorum: the circulating supply is read from
    /// the checkpoints one second before the proposal, so selling into (or buying out of) the pool
    /// just before proposing neither lowers nor raises the bar.
    function test_circulating_ignoresSameBlockPoolFlows() public {
        _distribute();
        uint256 pooled = tokenContract.balanceOf(factory);
        vm.prank(factory);
        tokenContract.transfer(poolManager, pooled);
        vm.warp(block.timestamp + 1 days + 1);
        uint64 circulating = uint64((tokenContract.totalSupply() - pooled) / WHOLE);

        // In the proposing block: the whale sells half into the pool, the pool pays out to mid.
        vm.prank(whale);
        tokenContract.transfer(poolManager, 5_000_000_000 * WHOLE);
        vm.prank(poolManager);
        tokenContract.transfer(nobody, 20_000_000_000 * WHOLE);

        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        ITakeoverGovernor.Proposal memory p = gov.getProposal(id);
        assertEq(p.circulatingWeight, circulating);
        assertEq(p.quorumWeight, uint256(circulating) * P.quorumBps / 10_000);
    }

    /// Only the pool manager fixed at construction is excluded, and it cannot be changed: every
    /// other holder (a locker, a vault, any contract) counts in the circulating supply, so no
    /// owner or controller action can shrink the base the quorum is measured against.
    function test_circulating_excludesOnlyTheImmutablePoolManager() public {
        _distribute();
        address locker = makeAddr("locker");
        uint256 rest = tokenContract.balanceOf(factory);
        vm.startPrank(factory);
        tokenContract.transfer(poolManager, rest / 2);
        tokenContract.transfer(locker, rest - rest / 2);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days + 1);

        // Parameter and scheme changes leave the excluded account as it was.
        vm.startPrank(owner);
        gov.setParams(P);
        gov.setScheme(address(scheme));
        vm.stopPrank();
        assertEq(gov.poolManager(), poolManager);

        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        uint64 expected = uint64((tokenContract.totalSupply() - rest / 2) / WHOLE);
        assertEq(gov.getProposal(id).circulatingWeight, expected);
    }

    /// Early in a token's life, with most of the supply still in the pool, holders reach quorum.
    function test_quorumReachableWhilePoolHoldsMostSupply() public {
        _distribute();
        uint256 rest = tokenContract.balanceOf(factory);
        vm.prank(factory);
        tokenContract.transfer(poolManager, rest);
        vm.warp(block.timestamp + 1 days + 1);

        // Circulating: 17% of the supply; quorum 10% of it. mid's 5% of supply clears it.
        vm.prank(proposer);
        uint256 id = gov.propose(token, newController);
        _vote(id, mid, FOR);
        vm.warp(gov.getProposal(id).end + 1);
        gov.closeProposal(id);
        scheme.finalizeFromBallots(address(gov), token, id);
        gov.recordTally(id);
        _assertState(id, ITakeoverGovernor.State.Succeeded);
        gov.execute(id);
        assertEq(profiles.controllerOf(token), newController);
    }
}
