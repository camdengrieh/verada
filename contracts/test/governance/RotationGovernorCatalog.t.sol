// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CatalogBallotBuilder} from "../../src/CatalogBallotBuilder.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "../../src/interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IOutcomeVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/external/IERC8004IdentityRegistry.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {IdentityRegistryMock} from "../mocks/IdentityRegistryMock.sol";
import {BallotLog} from "../utils/BallotLog.sol";
import {CatalogFixture, CatalogTree} from "../utils/CatalogFixture.sol";

/// @dev Profile registry stand-in that also exposes a parent node (for `CuratorRegistry`).
contract CatalogProfiles is MockProfileRegistryLite {
    bytes32 public constant parentNode = keccak256("parent");
}

/// @notice Live rounds choose candidates exactly as weekly epochs do: pins, curated picks and
///         rotation draws over the focus pool, prepared permissionlessly and frozen.
/// @dev Catalogue (as `EpochGovernorRotationTest`): 30 orgs in hunger x Africa, 20 in children x
///      Africa (the first 5 also in hunger x Africa), 10 in hunger x Europe outside the focus. The
///      token's focus is {hunger, children} x Africa, a pool of 50; ballots hold 10 options. A
///      weekly governor is the curator registry's clock and the reference for equivalence.
contract RotationGovernorCatalogTest is Test, BallotLog {
    uint8 internal constant HUNGER = 2;
    uint64 internal constant FOCUS_C = (uint64(1) << 2) | (uint64(1) << 3);
    uint16 internal constant FOCUS_R = uint16(1);
    uint16 internal constant HUNGER_AF = 32;

    CatalogFixture internal cat;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    CatalogProfiles internal profiles;
    EpochGovernor internal weekly;
    CuratorRegistry internal curators;
    RotationGovernor internal gov;
    VaradaToken internal tokenContract;
    address internal token;
    bytes32 internal initialCause;
    uint256 internal t0;

    address internal creator = makeAddr("creator");
    address internal voter = makeAddr("voter");
    address internal signer = makeAddr("signer");

    /// @dev Curated picks of hunger x Africa: catalogue index and claimed org, by rank.
    uint32[] internal _pickIndex;
    bytes32[] internal _pickOrg;

    function _org(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("org", i));
    }

    function _cause(bytes32 orgId) internal pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    function setUp() public {
        _recordBallots();
        vm.warp(1_750_000_123);
        tokenContract =
            new VaradaToken("Varada Live", "VLIVE", "ipfs://meta", creator, address(this));
        token = address(tokenContract);
        tokenContract.transfer(voter, 1000e18);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(orgFactory)));
        bytes32 initialOrg = _org(999);
        initialCause = _cause(initialOrg);
        registry.addCause(initialCause, initialOrg, orgFactory.computeOrgAddress(initialOrg), "");
        scheme = new MockVotingScheme();
        scheme.setMaxOptions(10);
        profiles = new CatalogProfiles();

        cat = new CatalogFixture();
        for (uint256 i; i < 30; ++i) {
            cat.add(cat.bucketOf(2, 0), _org(i)); // entries 0..29
        }
        for (uint256 i; i < 20; ++i) {
            cat.add(cat.bucketOf(3, 0), _org(i < 5 ? i : 100 + i)); // entries 30..49
        }
        for (uint256 i; i < 10; ++i) {
            cat.add(cat.bucketOf(2, 2), _org(200 + i)); // entries 50..59, outside the focus
        }
        cat.publish();
        ICauseCatalog catalog = ICauseCatalog(address(cat.catalog()));

        weekly = new EpochGovernor(
            address(this), registry, catalog, scheme, ITokenProfileRegistry(address(profiles))
        );
        curators = new CuratorRegistry(
            address(this),
            IERC8004IdentityRegistry(address(new IdentityRegistryMock())),
            catalog,
            ICauseRegistry(address(registry)),
            IEndaomentOrgFundFactory(address(orgFactory)),
            IERC20(address(usdc)),
            ITokenProfileRegistry(address(profiles))
        );
        weekly.setFactory(address(this));
        weekly.setCuratorRegistry(ICuratorRegistry(address(curators)));
        curators.setGovernor(IEpochGovernor(address(weekly)));
        curators.registerAgent(HUNGER, "hunger", signer, "", "");
        registry.setMaterializer(address(weekly), true);
        scheme.setGovernor(address(weekly), true);

        gov = new RotationGovernor(
            address(this),
            registry,
            catalog,
            ITokenProfileRegistry(address(profiles)),
            makeAddr("poolManager"),
            IOutcomeVotingScheme(address(scheme)),
            IRotationGovernor.Params(24 hours, 3 days, 7 days, 1000, 50)
        );
        gov.setVault(address(this));
        gov.setCuratorRegistry(ICuratorRegistry(address(curators)));
        registry.setMaterializer(address(gov), true);
        scheme.setGovernor(address(gov), true);

        profiles.register(token, creator);
        profiles.setFocus(token, FOCUS_C, FOCUS_R);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Registers the token with both governors one hour into weekly epoch 1 (daily
    ///      rotations), so round 1's vote starts in epoch 1 under catalogue version 1.
    function _start() internal {
        vm.warp(weekly.epochStart(1) + 1 hours);
        weekly.registerToken(token);
        t0 = block.timestamp;
        gov.registerToken(token, initialCause, RotationPeriod.OneDay);
    }

    function _draws(uint64 target) internal view returns (IEpochGovernor.Draw[] memory) {
        return cat.draws(IEpochGovernor(address(gov)), registry, token, target, FOCUS_C, FOCUS_R);
    }

    function _rot(uint64 target) internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
    }

    function _status(uint64 target) internal view returns (IRotationGovernor.RoundStatus st) {
        (st,,,,,,) = gov.roundOf(token, target);
    }

    function _pickLeaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](_pickIndex.length);
        for (uint256 r; r < leaves.length; ++r) {
            leaves[r] = keccak256(
                bytes.concat(keccak256(abi.encode(uint8(r), _pickIndex[r], _pickOrg[r])))
            );
        }
    }

    /// @dev Ranks hunger x Africa entries 29, 28, 27 for weekly epoch 1 (submitted in epoch 0).
    function _submitPicks() internal {
        for (uint256 r; r < 3; ++r) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _pickIndex.push(uint32(29 - r));
            _pickOrg.push(_org(29 - r));
        }
        ICuratorRegistry.CurationInput[] memory c = new ICuratorRegistry.CurationInput[](1);
        c[0] = ICuratorRegistry.CurationInput(0, CatalogTree.root(_pickLeaves()), 3, 5000);
        vm.prank(signer);
        curators.submitCurations(HUNGER, 1, 1, bytes32("report"), c);
    }

    function _curated() internal view returns (IEpochGovernor.CuratedDraw[] memory d) {
        bytes32[] memory leaves = _pickLeaves();
        d = new IEpochGovernor.CuratedDraw[](leaves.length);
        for (uint256 r; r < leaves.length; ++r) {
            uint256 e = cat.find(HUNGER_AF, _pickIndex[r]);
            d[r] = IEpochGovernor.CuratedDraw({
                catalogIndex: _pickIndex[r],
                pickOrgId: _pickOrg[r],
                pickProof: CatalogTree.proof(leaves, r),
                entryOrgId: cat.entryAt(e).orgId,
                entryProof: cat.proofOf(e)
            });
        }
    }

    function _pins(uint256 a, uint256 b) internal view returns (IEpochGovernor.Pin[] memory p) {
        p = new IEpochGovernor.Pin[](2);
        p[0] = cat.pin(a);
        p[1] = cat.pin(b);
    }

    function _contains(bytes32[] memory list, bytes32 x) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == x) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ same as weekly

    function test_sameBallotAsTheWeeklyGovernor_pinsCuratedAndDraws() public {
        _submitPicks();
        _start();
        assertEq(weekly.currentEpoch(), 1);
        (bool ok, uint256 epoch) = gov.curationEpochOf(token, 1);
        assertTrue(ok);
        assertEq(epoch, 1, "the weekly epoch containing the vote start");

        // The same pins on both: hunger x Africa entry 3 and children x Africa entry 31.
        vm.startPrank(creator);
        weekly.setShortlist(token, _pins(3, 31));
        gov.setShortlist(token, _pins(3, 31));
        vm.stopPrank();
        assertEq(gov.shortlistOf(token), weekly.shortlistOf(token));

        (uint32 v, uint256 pool) = gov.poolOf(token, 1);
        (uint32 wv, uint256 wpool) = weekly.poolOf(token, 1);
        assertEq(v, wv);
        assertEq(pool, wpool);
        assertEq(pool, 50);
        assertEq(gov.ballotSize(), weekly.ballotSize());

        IEpochGovernor.CuratedDraw[] memory curated = _curated();
        bytes32[] memory taken = new bytes32[](5);
        taken[0] = _cause(_org(3));
        taken[1] = _cause(_org(1));
        for (uint256 r; r < 3; ++r) {
            taken[2 + r] = _cause(_org(29 - r));
        }
        IEpochGovernor.Draw[] memory d = cat.drawsAfter(
            IEpochGovernor(address(gov)), registry, token, 1, FOCUS_C, FOCUS_R, taken
        );
        IEpochGovernor.Draw[] memory dw =
            cat.drawsAfter(weekly, registry, token, 1, FOCUS_C, FOCUS_R, taken);
        assertEq(d.length, dw.length, "same draw count");
        for (uint256 k; k < d.length; ++k) {
            assertEq(d[k].orgId, dw[k].orgId, "same draws");
        }

        weekly.prepareCuratedBallot(token, 1, curated, dw);
        vm.expectEmit(address(gov));
        emit IRotationGovernor.CuratedPicksUsed(token, 1, 1, 3, 3);
        vm.prank(makeAddr("anyone"));
        gov.prepareCuratedRound(token, 1, curated, d);

        assertEq(gov.roundOptionOrgIds(token, 1), _orgIds(address(weekly), token, 1));
        (IRotationGovernor.RoundStatus st,,,,,, bytes32[] memory opts) = gov.roundOf(token, 1);
        assertEq(opts, _options(address(weekly), token, 1));
        assertEq(opts.length, 10);
        assertEq(opts[0], _cause(_org(3)), "pins first");
        assertEq(opts[2], _cause(_org(29)), "then curated picks");
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Open));
        assertTrue(scheme.isOpen(address(gov), token, _rot(1)));
        assertEq(scheme.optionCountOf(address(gov), token, _rot(1)), 10);
    }

    function test_drawsAreSeededWithTheTargetRotation() public {
        _start();
        vm.warp(t0 + 1 days + 10);
        IEpochGovernor.Draw[] memory d = _draws(2);
        gov.prepareRound(token, 2, d);
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, 2);
        assertEq(orgs.length, 10);
        // Draw 0 is pool entry drawIndex(token, 2, 1, 0, 50), always on the ballot first.
        uint256 idx = gov.drawIndex(token, 2, 1, 0, 50);
        assertEq(idx, uint256(keccak256(abi.encode(token, uint256(2), uint32(1), uint256(0)))) % 50);
        (uint16 bucket, uint32 index) = cat.catalog().locate(1, FOCUS_C, FOCUS_R, idx);
        assertEq(orgs[0], cat.entryAt(cat.find(bucket, index)).orgId);
        for (uint256 i; i < orgs.length; ++i) {
            for (uint256 j; j < i; ++j) {
                assertTrue(orgs[i] != orgs[j], "repeat");
            }
            for (uint256 e = 50; e < 60; ++e) {
                assertTrue(orgs[i] != cat.entryAt(e).orgId, "outside the focus");
            }
        }
        // The next round draws differently.
        vm.warp(t0 + 2 days + 10);
        gov.prepareRound(token, 3, _draws(3));
        assertTrue(
            keccak256(abi.encode(gov.roundOptionOrgIds(token, 3))) != keccak256(abi.encode(orgs))
        );
    }

    // ------------------------------------------------------------------ frozen, never lazy

    function test_ballotsBeforePreparationAreRefused() public {
        _start();
        vm.warp(t0 + 1 days + 10);
        vm.prank(voter);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundNotOpened.selector, token, uint64(2))
        );
        scheme.castBallot(address(gov), token, _rot(2), abi.encode(uint8(0)));
        assertFalse(scheme.isOpen(address(gov), token, _rot(2)), "no poll opened by a ballot");
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.None));
        // Nothing prepared: closing is refused and the current cause continues.
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundNotOpened.selector, token, uint64(2))
        );
        gov.closeRound(token, 2);
        vm.warp(t0 + 2 days);
        (bytes32 c,) = gov.activeCause(token);
        assertEq(c, initialCause);
    }

    function test_ballotIsFrozenAtPreparation() public {
        _start();
        IEpochGovernor.Pin[] memory pins = _pins(3, 31);
        vm.prank(creator);
        gov.setShortlist(token, pins);
        vm.warp(t0 + 1 days + 10);
        gov.prepareRound(token, 2, _draws(2));
        bytes32[] memory before = gov.roundOptionOrgIds(token, 2);
        assertEq(before[0], _org(3));

        // New pins and a blocked option change nothing for the prepared round.
        pins = _pins(7, 8);
        vm.prank(creator);
        gov.setShortlist(token, pins);
        uint256 blocked = 2;
        while (before[blocked] == _org(7) || before[blocked] == _org(8)) ++blocked;
        registry.blockOrg(before[blocked]);
        assertEq(gov.roundOptionOrgIds(token, 2), before);
        (uint32 v, uint256 pool) = gov.poolOf(token, 2);
        assertEq(v, 1);
        assertEq(pool, 50);

        // The next round uses the new pins and skips the blocked org.
        vm.warp(t0 + 2 days + 10);
        gov.prepareRound(token, 3, _draws(3));
        bytes32[] memory next = gov.roundOptionOrgIds(token, 3);
        assertEq(next[0], _org(7));
        assertEq(next[1], _org(8));
        assertFalse(_contains(next, before[blocked]), "blocked org skipped");
    }

    function test_blockedPinsAndDrawsAreSkipped() public {
        _start();
        IEpochGovernor.Pin[] memory pins = _pins(3, 4);
        vm.prank(creator);
        gov.setShortlist(token, pins);
        registry.blockOrg(_org(3));
        vm.warp(t0 + 1 days + 10);
        uint256 first = gov.drawIndex(token, 2, 1, 0, 50);
        (uint16 bucket, uint32 index) = cat.catalog().locate(1, FOCUS_C, FOCUS_R, first);
        bytes32 drawn = cat.entryAt(cat.find(bucket, index)).orgId;
        if (drawn != _org(4)) registry.blockOrg(drawn);
        gov.prepareRound(token, 2, _draws(2));
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, 2);
        assertEq(orgs[0], _org(4), "the blocked pin is skipped");
        assertFalse(_contains(orgs, _org(3)));
        assertFalse(_contains(orgs, drawn) && drawn != _org(4), "blocked draw skipped");
        assertEq(orgs.length, 10);
    }

    function test_catalogVersionOfTheWeeklyEpoch() public {
        _start();
        // A version published mid-week (weekly epoch 1) applies from the first round voting in
        // epoch 2, as for weekly ballots: rounds 2 and 3 keep version 1.
        vm.warp(t0 + 1 days + 10);
        // The fixture proves against its latest tree: take the version-1 draws first.
        IEpochGovernor.Draw[] memory d2 = _draws(2);
        IEpochGovernor.Draw[] memory d3 = _draws(3);
        cat.add(cat.bucketOf(2, 0), _org(300));
        cat.publish();
        (uint32 v2, uint256 p2) = gov.poolOf(token, 2);
        assertEq(v2, 1);
        assertEq(p2, 50);
        (uint32 v3, uint256 p3) = gov.poolOf(token, 3);
        assertEq(v3, 1, "same week, same version");
        assertEq(p3, 50);
        (uint32 wv,) = weekly.poolOf(token, 1);
        assertEq(wv, 1);
        // Round 8 votes from t0 + 7 days, inside weekly epoch 2.
        (bool ok, uint256 epoch) = gov.curationEpochOf(token, 8);
        assertTrue(ok);
        assertEq(epoch, 2);
        (uint32 v8, uint256 p8) = gov.poolOf(token, 8);
        (uint32 wv2, uint256 wp2) = weekly.poolOf(token, 2);
        assertEq(v8, 2);
        assertEq(p8, 51);
        assertEq(v8, wv2);
        assertEq(p8, wp2);
        // Version-2 proofs do not verify against round 2's version-1 root.
        IEpochGovernor.Draw[] memory latest = _draws(2);
        vm.expectRevert();
        gov.prepareRound(token, 2, latest);
        gov.prepareRound(token, 2, d2);
        vm.warp(t0 + 2 days + 10);
        gov.prepareRound(token, 3, d3);
        (v3, p3) = gov.poolOf(token, 3);
        assertEq(v3, 1, "stored");
        assertEq(p3, 50);
    }

    function test_catalogVersionAtTheVoteStart_withoutACuratorClock() public {
        RotationGovernor g = new RotationGovernor(
            address(this),
            registry,
            ICauseCatalog(address(cat.catalog())),
            ITokenProfileRegistry(address(profiles)),
            makeAddr("poolManager"),
            IOutcomeVotingScheme(address(scheme)),
            IRotationGovernor.Params(24 hours, 3 days, 7 days, 1000, 50)
        );
        g.setVault(address(this));
        vm.warp(weekly.epochStart(1) + 1 hours);
        uint256 start = block.timestamp;
        g.registerToken(token, initialCause, RotationPeriod.OneDay);
        vm.warp(start + 12 hours);
        cat.publish();
        (uint32 v2,) = g.poolOf(token, 2);
        assertEq(v2, 2, "no weekly epoch: the version at the vote start");
    }

    function test_noBallot_belowTwoOptions_keepsTheCurrentCause() public {
        // A token whose focus is hunger x Europe (ten orgs), nine of them blocked.
        address other = address(new VaradaToken("O", "O", "", creator, address(this)));
        profiles.register(other, creator);
        profiles.setFocus(other, uint64(1) << 2, uint16(1) << 2);
        _start();
        gov.registerToken(other, initialCause, RotationPeriod.OneDay);
        for (uint256 i = 1; i < 10; ++i) {
            registry.blockOrg(_org(200 + i));
        }
        vm.warp(t0 + 1 days + 10);
        IEpochGovernor.Draw[] memory d = cat.draws(
            IEpochGovernor(address(gov)), registry, other, 2, uint64(1) << 2, uint16(1) << 2
        );
        vm.expectEmit(address(gov));
        emit IRotationGovernor.RoundFinalized(
            other, 2, IRotationGovernor.RoundStatus.NoBallot, bytes32(0), 0
        );
        gov.prepareRound(other, 2, d);
        assertEq(gov.roundOptionOrgIds(other, 2).length, 1);
        assertFalse(scheme.isOpen(address(gov), other, _rot(2)));
        vm.prank(voter);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.NoShortlist.selector, other));
        scheme.castBallot(address(gov), other, _rot(2), abi.encode(uint8(0)));
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundAlreadyClosed.selector, other, uint64(2))
        );
        gov.closeRound(other, 2);
        vm.warp(t0 + 2 days);
        (bytes32 c,) = gov.activeCause(other);
        assertEq(c, initialCause);
    }

    function test_onlyTheWinnerIsMaterialized() public {
        _start();
        vm.warp(t0 + 1 days + 10);
        gov.prepareRound(token, 2, _draws(2));
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, 2);
        for (uint256 i; i < orgs.length; ++i) {
            assertFalse(registry.exists(_cause(orgs[i])), "preparation writes no cause");
        }
        vm.prank(voter);
        scheme.castBallot(address(gov), token, _rot(2), abi.encode(uint8(4)));
        (,, uint40 end,,,,) = gov.roundOf(token, 2);
        vm.warp(end);
        gov.closeRound(token, 2);
        scheme.finalizeFromBallots(address(gov), token, _rot(2));
        gov.finalizeRound(token, 2);
        for (uint256 i; i < orgs.length; ++i) {
            assertEq(registry.exists(_cause(orgs[i])), i == 4, "winner only");
        }
        vm.warp(t0 + 2 days);
        (bytes32 c,) = gov.activeCause(token);
        assertEq(c, _cause(orgs[4]));
    }

    // ------------------------------------------------------------------ preparation checks

    function test_prepare_checks() public {
        IEpochGovernor.Draw[] memory none = new IEpochGovernor.Draw[](0);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.TokenNotRegistered.selector, token)
        );
        gov.prepareRound(token, 1, none);
        _start();
        vm.warp(t0 + 1 days + 10);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.RoundNotCurrent.selector, 3));
        gov.prepareRound(token, 3, none);

        IEpochGovernor.Draw[] memory d = _draws(2);
        // A missing draw, a wrong org, an extra draw.
        IEpochGovernor.Draw[] memory short = new IEpochGovernor.Draw[](1);
        short[0] = d[0];
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteBallot.selector, token, 2, 1)
        );
        gov.prepareRound(token, 2, short);
        bytes32 real = d[1].orgId;
        d[1].orgId = _org(200);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.InvalidDraw.selector, 1));
        gov.prepareRound(token, 2, d);
        d[1].orgId = real;
        IEpochGovernor.Draw[] memory extra = new IEpochGovernor.Draw[](d.length + 1);
        for (uint256 i; i < d.length; ++i) {
            extra[i] = d[i];
        }
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.TooManyDraws.selector, d.length + 1, d.length)
        );
        gov.prepareRound(token, 2, extra);
        // Curated draws with no curation for the epoch.
        IEpochGovernor.CuratedDraw[] memory c = new IEpochGovernor.CuratedDraw[](1);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TooManyCuratedDraws.selector, 1, 0));
        gov.prepareCuratedRound(token, 2, c, d);

        gov.prepareRound(token, 2, d);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.RoundAlreadyOpened.selector, token, 2)
        );
        gov.prepareRound(token, 2, d);
    }

    function test_setShortlist_checks() public {
        IEpochGovernor.Pin[] memory pins = _pins(3, 31);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.TokenNotRegistered.selector, token)
        );
        gov.setShortlist(token, pins);
        _start();
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.NotController.selector, token, address(this))
        );
        gov.setShortlist(token, pins);

        IEpochGovernor.Pin[] memory p = _pins(3, 50);
        IEpochGovernor.Pin[] memory bad = _pins(3, 4);
        IEpochGovernor.Pin[] memory dup = _pins(3, 3);
        IEpochGovernor.Pin[] memory nine = new IEpochGovernor.Pin[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = cat.pin(i);
        }
        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.OutOfFocus.selector, _org(200), uint16(34))
        );
        gov.setShortlist(token, p);
        bad[1].orgId = _org(5);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotInCatalog.selector, _org(5)));
        gov.setShortlist(token, bad);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, dup);
        vm.expectRevert(IEpochGovernor.InvalidShortlist.selector);
        gov.setShortlist(token, nine);
        vm.stopPrank();
        registry.blockOrg(_org(4));
        p = _pins(3, 4);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.InactiveCause.selector, _cause(_org(4)))
        );
        gov.setShortlist(token, p);

        vm.startPrank(creator);
        vm.expectEmit(address(gov));
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = _cause(_org(3));
        ids[1] = _cause(_org(1));
        emit IRotationGovernor.ShortlistSet(token, ids);
        gov.setShortlist(token, pins);
        assertEq(gov.shortlistOf(token), ids);
        assertEq(gov.shortlistFor(token, 7), ids);
        assertEq(gov.shortlistOrgIdsOf(token)[1], _org(1));
        gov.setShortlist(token, new IEpochGovernor.Pin[](0));
        assertEq(gov.shortlistOf(token).length, 0, "cleared");
        vm.stopPrank();
    }

    function test_setCuratorRegistry_onceWithAClock() public {
        assertEq(address(gov.curators()), address(curators));
        vm.expectRevert(IRotationGovernor.CuratorRegistryAlreadySet.selector);
        gov.setCuratorRegistry(ICuratorRegistry(address(curators)));

        RotationGovernor g = new RotationGovernor(
            address(this),
            registry,
            ICauseCatalog(address(cat.catalog())),
            ITokenProfileRegistry(address(profiles)),
            makeAddr("poolManager"),
            IOutcomeVotingScheme(address(scheme)),
            IRotationGovernor.Params(24 hours, 3 days, 7 days, 1000, 50)
        );
        vm.expectRevert(IRotationGovernor.ZeroAddress.selector);
        g.setCuratorRegistry(ICuratorRegistry(address(0)));
        CuratorRegistry noClock = new CuratorRegistry(
            address(this),
            IERC8004IdentityRegistry(address(new IdentityRegistryMock())),
            ICauseCatalog(address(cat.catalog())),
            ICauseRegistry(address(registry)),
            IEndaomentOrgFundFactory(address(registry.endaomentFactory())),
            IERC20(address(new MockUSDC())),
            ITokenProfileRegistry(address(profiles))
        );
        vm.expectRevert(IRotationGovernor.CuratorClockNotSet.selector);
        g.setCuratorRegistry(ICuratorRegistry(address(noClock)));
        vm.prank(creator);
        vm.expectRevert();
        g.setCuratorRegistry(ICuratorRegistry(address(curators)));
        // Without curators there is no curated phase.
        (bool ok,) = g.curationEpochOf(token, 1);
        assertFalse(ok);
    }

    function test_register_focusPoolTooSmall() public {
        address other = address(new VaradaToken("O", "O", "", creator, address(this)));
        profiles.setFocus(other, uint64(1) << 9, FOCUS_R); // no entries
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, other, 0));
        gov.registerToken(other, initialCause, RotationPeriod.OneDay);
    }

    // ------------------------------------------------------------------ published picks

    /// @dev Round `target`'s ballot is the rotation draws alone (repeats skipped, nothing
    ///      blocked here), as `prepareRound` builds it without a curated phase.
    function _expectNoCuratedPhase(uint64 target) internal view {
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, target);
        IEpochGovernor.Draw[] memory d = _draws(target);
        assertEq(orgs.length, 10);
        uint256 n;
        for (uint256 k; k < d.length; ++k) {
            bool repeat;
            for (uint256 j; j < n; ++j) {
                if (orgs[j] == d[k].orgId) repeat = true;
            }
            if (repeat) continue;
            assertEq(orgs[n++], d[k].orgId, "rotation draws only");
        }
        assertEq(n, orgs.length);
    }

    function _incompleteCurated(uint64 target) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IEpochGovernor.IncompleteCuratedBallot.selector, token, uint256(target), 0
        );
    }

    /// @dev Regression (audit #8): published picks are needed for the whole vote window. After
    ///      the old grace, a preparer could open each round without them and freeze them out.
    function test_publishedPicks_requiredForTheWholeVoteWindow() public {
        _submitPicks();
        _start();
        for (uint64 target = 2; target <= 7; ++target) {
            uint256 voteStart = t0 + (target - 1) * 1 days;
            _expectPicksRequired(target, voteStart);
            _expectPicksRequired(target, voteStart + 6 hours);
            _expectPicksRequired(target, voteStart + 1 days - 6 hours - 1);
            gov.prepareCuratedRound(token, target, _curated(), _curatedDraws(target));
            assertEq(gov.roundOptionOrgIds(token, target)[0], _org(29), "curated picks first");
        }
        // The weekly governor has no skip either.
        vm.warp(weekly.epochStart(1) + weekly.curationGrace() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.CurationSkipDisabled.selector, token, 1)
        );
        weekly.requestCurationSkip(token, 1);
        IEpochGovernor.Draw[] memory wd = cat.draws(weekly, registry, token, 1, FOCUS_C, FOCUS_R);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.IncompleteCuratedBallot.selector, token, 1, 0)
        );
        weekly.prepareBallot(token, 1, wd);
    }

    /// @dev At `at`, round `target` cannot be prepared without its published picks.
    function _expectPicksRequired(uint64 target, uint256 at) internal {
        vm.warp(at);
        IEpochGovernor.Draw[] memory d = _draws(target);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(_incompleteCurated(target));
        gov.prepareRound(token, target, d);
        vm.expectRevert(_incompleteCurated(target));
        gov.openRound(token);
    }

    /// @dev Round 2's builder request (daily rotations).
    function _request2() internal view returns (CatalogBallotBuilder.Request memory q) {
        q.token = token;
        q.round = 2;
        q.size = gov.maxOptions();
        q.voteStart = t0 + 1 days;
        q.voteEnd = t0 + 2 days - 6 hours;
    }

    /// @dev Calls `build` without decoding its result (keeps the test's stack small).
    function _build(
        CatalogBallotBuilder.Request memory q,
        IEpochGovernor.CuratedDraw[] memory curated,
        IEpochGovernor.Draw[] memory draws
    ) internal view returns (bool ok, bytes memory ret) {
        CatalogBallotBuilder b = gov.ballotBuilder();
        (ok, ret) = address(b).staticcall(abi.encodeCall(b.build, (q, curated, draws)));
    }

    function _buildWithoutPicks(CatalogBallotBuilder.Request memory q) internal view {
        (bool ok, bytes memory ret) = _build(q, new IEpochGovernor.CuratedDraw[](0), _draws(2));
        assertFalse(ok, "no ballot without the published picks");
        assertEq(ret, _incompleteCurated(2));
    }

    function _buildWithPicks(CatalogBallotBuilder.Request memory q) internal view {
        (bool ok, bytes memory ret) = _build(q, _curated(), _curatedDraws(2));
        assertTrue(ok);
        uint256 drawn;
        // `Built.curatedDrawn`: fifth head word of the returned struct.
        assembly ("memory-safe") {
            drawn := mload(add(ret, 192))
        }
        assertEq(drawn, 3);
    }

    /// @dev Regression (audit #4): after the grace the builder still rejects a ballot without
    ///      the published picks, so its caller cannot choose the ballot form.
    function test_builder_publishedPicksStayRequiredAfterTheGrace() public {
        _submitPicks();
        _start();
        CatalogBallotBuilder.Request memory q = _request2();
        vm.warp(gov.ballotBuilder().curationGraceEnd(q.voteStart, q.voteEnd) + 1);
        _buildWithoutPicks(q);
        _buildWithPicks(q);
    }

    /// @dev Liveness: picks committed but never served are dropped by pausing the agent; rounds
    ///      then prepare with rotation alone. Without usable curations no curated draws are needed.
    function test_unservedPicks_pausedAgent_roundsFallBackToRotation() public {
        _submitPicks();
        _start();
        vm.warp(t0 + 1 days);
        IEpochGovernor.Draw[] memory d = _draws(2);
        vm.expectRevert(_incompleteCurated(2));
        gov.prepareRound(token, 2, d);
        curators.setActive(HUNGER, false);
        gov.prepareRound(token, 2, d);
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.Open));
        _expectNoCuratedPhase(2);
        vm.warp(weekly.epochStart(1) + 1 hours);
        weekly.prepareBallot(token, 1, cat.draws(weekly, registry, token, 1, FOCUS_C, FOCUS_R));
    }

    /// @dev Regression (review): the agent has to be active to submit the next epoch's picks,
    ///      and reactivating it during the stuck epoch made its unserved picks block that epoch's
    ///      remaining rounds again. `voidCurations` drops the one epoch's picks instead.
    function test_voidCurations_unblocksTheEpochsRounds_agentSubmitsTheNext() public {
        _submitPicks();
        _start();
        vm.warp(t0 + 1 days);
        curators.setActive(HUNGER, false);
        gov.prepareRound(token, 2, _draws(2));
        // Reactivated so it can curate epoch 2: round 3 (still in epoch 1) is blocked again.
        curators.setActive(HUNGER, true);
        vm.warp(t0 + 2 days);
        IEpochGovernor.Draw[] memory d = _draws(3);
        vm.expectRevert(_incompleteCurated(3));
        gov.prepareRound(token, 3, d);

        uint16[] memory buckets = new uint16[](1);
        buckets[0] = HUNGER_AF;
        curators.voidCurations(1, buckets);
        gov.prepareRound(token, 3, d);
        _expectNoCuratedPhase(3);
        weekly.prepareBallot(token, 1, cat.draws(weekly, registry, token, 1, FOCUS_C, FOCUS_R));

        ICuratorRegistry.CurationInput[] memory c = new ICuratorRegistry.CurationInput[](1);
        c[0] = ICuratorRegistry.CurationInput(0, CatalogTree.root(_pickLeaves()), 3, 5000);
        vm.prank(signer);
        curators.submitCurations(HUNGER, 2, 1, bytes32("report2"), c);
        assertEq(curators.curationOf(HUNGER_AF, 2).count, 3);
    }

    /// @dev Liveness: with no curations at all, a round prepares at its vote start.
    function test_noCurations_roundPreparesAtOnce() public {
        _start();
        vm.warp(t0 + 1 days);
        gov.prepareRound(token, 2, _draws(2));
        assertEq(uint8(_status(2)), uint8(IRotationGovernor.RoundStatus.Open));
        _expectNoCuratedPhase(2);
    }

    function _curatedDraws(uint64 target) internal view returns (IEpochGovernor.Draw[] memory) {
        bytes32[] memory taken = new bytes32[](3);
        for (uint256 r; r < 3; ++r) {
            taken[r] = _cause(_org(29 - r));
        }
        return cat.drawsAfter(
            IEpochGovernor(address(gov)), registry, token, target, FOCUS_C, FOCUS_R, taken
        );
    }

    function test_curationGrace_publishedCuratedDrawsStillApply() public {
        _submitPicks();
        _start();
        vm.warp(t0 + 1 days + 7 hours); // past the grace
        vm.expectEmit(address(gov));
        emit IRotationGovernor.CuratedPicksUsed(token, 2, 1, 3, 3);
        gov.prepareCuratedRound(token, 2, _curated(), _curatedDraws(2));
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, 2);
        assertEq(orgs[0], _org(29), "curated picks first");
        assertEq(orgs[1], _org(28));
        assertEq(orgs[2], _org(27));
    }

    /// @dev Hourly rounds need published picks past the old 15-minute grace too.
    function test_publishedPicks_requiredInShortPeriods() public {
        _submitPicks();
        vm.warp(weekly.epochStart(1) + 1 hours);
        t0 = block.timestamp;
        gov.registerToken(token, initialCause, RotationPeriod.OneHour);
        vm.warp(t0 + 1 hours + 15 minutes);
        IEpochGovernor.Draw[] memory d = _draws(2);
        vm.expectRevert(_incompleteCurated(2));
        gov.prepareRound(token, 2, d);
        gov.prepareCuratedRound(token, 2, _curated(), _curatedDraws(2));
        assertEq(gov.roundOptionOrgIds(token, 2)[0], _org(29));
        (,, uint40 voteEnd,,,,) = gov.roundOf(token, 2);
        assertEq(voteEnd, t0 + 2 hours - 15 minutes, "half the hour still votes");
    }

    // ------------------------------------------------------------------ catalogue drift

    /// @dev A catalogue version published mid-week keeps the week's curated phase in both
    ///      governors: later rounds use the weekly epoch's version, under which the curations
    ///      were submitted.
    function test_midWeekCatalogPublish_keepsCuratedPicksInBothGovernors() public {
        _submitPicks();
        _start();
        vm.warp(t0 + 12 hours);
        cat.publish(); // version 2, same entries (so the fixture's proofs fit both)
        assertEq(cat.catalog().latestVersion(), 2);

        vm.warp(t0 + 1 days + 10);
        (uint32 v,) = gov.poolOf(token, 2);
        (uint32 wv,) = weekly.poolOf(token, 1);
        assertEq(v, 1, "the weekly epoch's version");
        assertEq(v, wv);
        // The curated phase still applies: without the picks the round cannot be prepared.
        IEpochGovernor.Draw[] memory plain = _draws(2);
        vm.expectRevert(_incompleteCurated(2));
        gov.prepareRound(token, 2, plain);

        IEpochGovernor.CuratedDraw[] memory curated = _curated();
        vm.expectEmit(address(gov));
        emit IRotationGovernor.CuratedPicksUsed(token, 2, 1, 3, 3);
        gov.prepareCuratedRound(token, 2, curated, _curatedDraws(2));
        (v,) = gov.poolOf(token, 2);
        assertEq(v, 1, "stored");
        bytes32[] memory orgs = gov.roundOptionOrgIds(token, 2);
        assertEq(orgs[0], _org(29));

        // The weekly ballot of the same epoch includes the same picks.
        bytes32[] memory taken = new bytes32[](3);
        for (uint256 r; r < 3; ++r) {
            taken[r] = _cause(_org(29 - r));
        }
        weekly.prepareCuratedBallot(
            token, 1, curated, cat.drawsAfter(weekly, registry, token, 1, FOCUS_C, FOCUS_R, taken)
        );
        bytes32[] memory w = _orgIds(address(weekly), token, 1);
        assertEq(w[0], _org(29));
        assertEq(w[1], _org(28));
        assertEq(w[2], _org(27));
    }

    function test_builderCurators_setOnceByTheGovernor() public {
        CatalogBallotBuilder b = gov.ballotBuilder();
        assertEq(b.governor(), address(gov));
        assertEq(address(b.curators()), address(curators));
        assertEq(b.curationZero(), weekly.epochZeroStart());
        assertEq(b.curationLength(), weekly.epochLength());
        vm.expectRevert(CatalogBallotBuilder.NotGovernor.selector);
        b.setCurators(ICuratorRegistry(address(curators)), 0, 1);
        vm.prank(address(gov));
        vm.expectRevert(CatalogBallotBuilder.CuratorsAlreadySet.selector);
        b.setCurators(ICuratorRegistry(address(curators)), 0, 1);
        // The grace is the close buffer: 6 hours, or a quarter of a short period.
        assertEq(b.curationGraceEnd(100, 100 + 1 days - 6 hours), 100 + 6 hours);
        assertEq(b.curationGraceEnd(100, 100 + 7 days - 6 hours), 100 + 6 hours);
        assertEq(b.curationGraceEnd(100, 100 + 45 minutes), 100 + 15 minutes);
        assertEq(b.curationGraceEnd(100, 100 + 9 hours), 100 + 3 hours);
    }
}
