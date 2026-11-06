// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "./utils/BallotLog.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CauseRegistry} from "../src/CauseRegistry.sol";
import {EpochGovernor} from "../src/EpochGovernor.sol";
import {VeradaToken} from "../src/VeradaToken.sol";
import {ICauseCatalog} from "../src/interfaces/ICauseCatalog.sol";
import {ICuratorRegistry} from "../src/interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {CurationsMock} from "./mocks/CurationsMock.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "./mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "./mocks/GovernanceMocks.sol";
import {CatalogFixture, CatalogTree} from "./utils/CatalogFixture.sol";

/// @notice Configurable ballot size: the owner's protocol cap, each token's own choice, the
///         timing rule they share with pins, pins past a lowered size, curated quotas at small
///         sizes, and prepared epochs keeping their stored size and option count.
///         Catalogue: 40 orgs in hunger x Africa (bucket 32), 20 in hunger x Asia (33); the
///         token's focus is hunger x {Africa, Asia} (pool 60) and the scheme allows 32 options.
contract EpochGovernorBallotSizeTest is BallotLog {
    uint256 internal constant WEEK = 7 days;
    uint256 internal constant T0 = 1_750_000_123;
    uint16 internal constant AF = 32;
    uint16 internal constant AS = 33;
    uint64 internal constant FOCUS_C = uint64(1) << 2;
    uint16 internal constant FOCUS_R = 3;

    CatalogFixture internal cat;
    CauseRegistry internal registry;
    MockVotingScheme internal scheme;
    MockProfileRegistryLite internal profiles;
    CurationsMock internal curations;
    EpochGovernor internal gov;
    address internal token;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal creator = makeAddr("creator");
    address internal v1 = makeAddr("v1");
    address internal v2 = makeAddr("v2");
    address internal nobody = makeAddr("nobody");

    /// @dev Pins of AF entries 0..9, cached so building them makes no external call.
    mapping(uint256 i => IEpochGovernor.Pin) internal _pinCache;

    function _af(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("af", i));
    }

    function _as(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("as", i));
    }

    function _cause(bytes32 orgId) internal pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    function setUp() public {
        _recordBallots();
        vm.warp(T0);
        VeradaToken t = new VeradaToken("Verada Test", "VTEST", "ipfs://meta", creator, factory);
        token = address(t);
        vm.startPrank(factory);
        t.transfer(v1, 100e18);
        t.transfer(v2, 250e18);
        vm.stopPrank();
        vm.warp(T0 + WEEK);

        MockUSDC usdc = new MockUSDC();
        MockOrgFactory orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        scheme = new MockVotingScheme();
        profiles = new MockProfileRegistryLite();
        curations = new CurationsMock();

        cat = new CatalogFixture();
        for (uint256 i; i < 40; ++i) {
            cat.add(AF, _af(i)); // entries 0..39
        }
        for (uint256 i; i < 20; ++i) {
            cat.add(AS, _as(i)); // entries 40..59
        }
        cat.publish();
        for (uint256 i; i < 10; ++i) {
            IEpochGovernor.Pin memory p = cat.pin(i);
            IEpochGovernor.Pin storage c = _pinCache[i];
            c.orgId = p.orgId;
            c.bucket = p.bucket;
            c.index = p.index;
            c.proof = p.proof;
        }

        gov = _newGov();
        profiles.register(token, creator);
        profiles.setFocus(token, FOCUS_C, FOCUS_R);
        vm.startPrank(owner);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        // The catalogue applies from the first epoch starting after it was published.
        vm.warp(gov.epochStart(1));
    }

    // ---- helpers

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

    /// @dev The first `n` AF entries as pins.
    function _pins(uint256 n) internal view returns (IEpochGovernor.Pin[] memory p) {
        p = new IEpochGovernor.Pin[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = _pinCache[i];
        }
    }

    function _setPins(uint256 n) internal {
        IEpochGovernor.Pin[] memory p = _pins(n);
        vm.prank(creator);
        gov.setShortlist(token, p);
    }

    function _setSize(uint8 size) internal {
        vm.prank(creator);
        gov.setBallotSize(token, size);
    }

    function _setCap(uint8 cap) internal {
        vm.prank(owner);
        gov.setBallotSizeCap(cap);
    }

    function _prepare(uint256 epoch) internal {
        gov.prepareBallot(token, epoch, cat.draws(gov, registry, token, epoch, FOCUS_C, FOCUS_R));
    }

    function _optionCount(uint256 epoch) internal view returns (uint256 n) {
        (, n) = gov.ballotCommitment(token, epoch);
    }

    function _toEpoch(uint256 epoch) internal {
        vm.warp(gov.epochStart(epoch));
    }

    // ---- configuration

    function test_defaults() public {
        assertEq(gov.MAX_OPTIONS(), 32);
        assertEq(gov.ballotSizeCap(), 32);
        assertEq(gov.ballotSizeChoiceOf(token), 0);
        assertEq(gov.ballotSize(), 32);
        assertEq(gov.ballotSizeFor(token, 1), 32);
        // The scheme still bounds every size.
        scheme.setMaxOptions(10);
        assertEq(gov.ballotSize(), 10);
        assertEq(gov.ballotSizeFor(token, 1), 10);
    }

    function test_deploy_emitsTheDefaultCap() public {
        vm.expectEmit(false, false, false, true);
        emit IEpochGovernor.BallotSizeCapSet(32);
        _newGov();
    }

    function test_setBallotSizeCap_onlyOwner_andRange() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator)
        );
        vm.prank(creator);
        gov.setBallotSizeCap(8);

        uint8[4] memory bad = [0, 1, 33, 255];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IEpochGovernor.BallotSizeOutOfRange.selector, bad[i])
            );
            vm.prank(owner);
            gov.setBallotSizeCap(bad[i]);
        }
        vm.expectEmit(false, false, false, true);
        emit IEpochGovernor.BallotSizeCapSet(2);
        _setCap(2);
        assertEq(gov.ballotSizeCap(), 2);
        assertEq(gov.ballotSize(), 2);
        _setCap(32);
        assertEq(gov.ballotSizeCap(), 32);
    }

    function test_setBallotSize_onlyTheController_andRange() public {
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, nobody)
        );
        vm.prank(nobody);
        gov.setBallotSize(token, 8);
        // The owner is not the pin authority either.
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.NotController.selector, token, owner));
        vm.prank(owner);
        gov.setBallotSize(token, 8);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TokenNotRegistered.selector, other));
        vm.prank(creator);
        gov.setBallotSize(other, 8);

        uint8[3] memory bad = [1, 33, 255];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IEpochGovernor.BallotSizeOutOfRange.selector, bad[i])
            );
            vm.prank(creator);
            gov.setBallotSize(token, bad[i]);
        }
        vm.expectEmit(true, false, false, true);
        emit IEpochGovernor.BallotSizeSet(token, 2, 1);
        _setSize(2);
        assertEq(gov.ballotSizeChoiceOf(token), 2);
        _setSize(32);
        assertEq(gov.ballotSizeChoiceOf(token), 32);
        _setSize(0);
        assertEq(gov.ballotSizeChoiceOf(token), 0);
    }

    function test_effectiveSize_isTheChoiceBoundedByCapAndScheme() public {
        _setSize(10);
        assertEq(gov.ballotSizeFor(token, 1), 10);
        // A choice above the cap gets the cap; the choice itself is kept.
        _setCap(8);
        assertEq(gov.ballotSizeFor(token, 1), 8);
        assertEq(gov.ballotSizeChoiceOf(token), 10);
        _setSize(0);
        assertEq(gov.ballotSizeFor(token, 1), 8);
        _setSize(3);
        assertEq(gov.ballotSizeFor(token, 1), 3);
        // Raising the cap again restores a larger choice.
        _setSize(30);
        _setCap(32);
        assertEq(gov.ballotSizeFor(token, 1), 30);
        scheme.setMaxOptions(6);
        assertEq(gov.ballotSizeFor(token, 1), 6);
    }

    /// @dev Per-token: another token keeps following the cap.
    function test_choiceIsPerToken() public {
        address t2 = makeAddr("t2");
        profiles.register(t2, nobody);
        profiles.setFocus(t2, FOCUS_C, FOCUS_R);
        vm.prank(factory);
        gov.registerToken(t2);
        _setSize(5);
        assertEq(gov.ballotSizeFor(token, 1), 5);
        assertEq(gov.ballotSizeFor(t2, 1), 32);
        assertEq(gov.ballotSizeChoiceOf(t2), 0);
    }

    // ---- timing (the pins' rule: read at preparation)

    function test_changeBeforePreparing_appliesToTheCurrentEpoch() public {
        _setSize(5);
        _prepare(1);
        assertEq(_optionCount(1), 5);
        assertEq(gov.ballotSizeFor(token, 1), 5);
        assertEq(_orgIds(address(gov), token, 1).length, 5);

        // A cap change before preparing applies the same way.
        _toEpoch(2);
        _setCap(4);
        _prepare(2);
        assertEq(_optionCount(2), 4);
    }

    function test_changeAfterPreparing_appliesFromTheNextEpochOnly() public {
        _prepare(1);
        assertEq(_optionCount(1), 32);

        vm.expectEmit(true, false, false, true);
        emit IEpochGovernor.BallotSizeSet(token, 3, 2);
        _setSize(3);
        _setCap(2);
        // Epoch 1 keeps the size and options it was prepared with.
        assertEq(gov.ballotSizeFor(token, 1), 32);
        assertEq(_optionCount(1), 32);
        assertEq(gov.ballotSizeFor(token, 2), 2);
        assertEq(gov.ballotSizeFor(token, 3), 2);

        _toEpoch(2);
        _setCap(32);
        assertEq(gov.ballotSizeFor(token, 2), 3);
        _prepare(2);
        assertEq(_optionCount(2), 3);
        // Changed during epoch 2 after it was prepared: epoch 3 only.
        _setSize(16);
        assertEq(gov.ballotSizeFor(token, 2), 3);
        _toEpoch(3);
        _prepare(3);
        assertEq(_optionCount(3), 16);
        assertEq(gov.ballotSizeFor(token, 1), 32);
        assertEq(gov.ballotSizeFor(token, 2), 3);
        assertEq(gov.ballotSizeFor(token, 3), 16);
    }

    /// @dev Shrinking the size while an epoch runs changes nothing for it: ballots, close and
    ///      finalize use its stored option count and commitment.
    function test_runningEpoch_isTalliedAtItsPreparedSize() public {
        _prepare(1);
        bytes32[] memory orgs = _orgIds(address(gov), token, 1);
        assertEq(orgs.length, 32);
        _setSize(2);
        _setCap(2);

        vm.prank(v1);
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(5)));
        vm.prank(v2);
        scheme.castBallot(address(gov), token, 1, abi.encode(uint8(31)));

        vm.warp(gov.epochStart(2));
        gov.closeEpoch(token, 1);
        scheme.finalizeFromBallots(address(gov), token, 1);
        // The committed 32 org ids, not a 2-option list.
        bytes32[] memory two = new bytes32[](2);
        two[0] = orgs[0];
        two[1] = orgs[1];
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.BallotMismatch.selector, token, 1));
        gov.finalizeEpoch(token, 1, two);
        gov.finalizeEpoch(token, 1, orgs);
        assertEq(gov.winningCause(token, 1), _cause(orgs[31]));
        assertEq(gov.tally(token, 1, _cause(orgs[31])), 250);
        assertEq(gov.tally(token, 1, _cause(orgs[5])), 100);

        // The next epoch is prepared at the new size.
        _prepare(2);
        assertEq(_optionCount(2), 2);
    }

    // ---- pins

    function test_shortlistLongerThanTheSize_isRejected() public {
        _setSize(3);
        IEpochGovernor.Pin[] memory four = _pins(4);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.ShortlistTooLong.selector, 4, 3));
        vm.prank(creator);
        gov.setShortlist(token, four);
        _setPins(3);
        assertEq(gov.shortlistOf(token).length, 3);

        // The cap bounds it too, and so does the scheme.
        _setSize(0);
        _setCap(2);
        IEpochGovernor.Pin[] memory three = _pins(3);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.ShortlistTooLong.selector, 3, 2));
        vm.prank(creator);
        gov.setShortlist(token, three);
        _setCap(32);
        scheme.setMaxOptions(2);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.ShortlistTooLong.selector, 3, 2));
        vm.prank(creator);
        gov.setShortlist(token, three);
    }

    /// @dev Pins set at a larger size stay stored; a ballot takes the first `size` unblocked ones
    ///      and needs no draw.
    function test_loweredCap_dropsPinsPastTheSizeInOrder() public {
        _setPins(5);
        vm.prank(owner);
        registry.blockOrg(_af(1));
        _setCap(3);
        assertEq(gov.shortlistOf(token).length, 5);
        assertEq(cat.draws(gov, registry, token, 1, FOCUS_C, FOCUS_R).length, 0);

        gov.openEpoch(token, 1);
        bytes32[] memory orgs = _orgIds(address(gov), token, 1);
        assertEq(orgs.length, 3);
        assertEq(orgs[0], _af(0));
        assertEq(orgs[1], _af(2));
        assertEq(orgs[2], _af(3));
        assertTrue(gov.isOpened(token, 1));
    }

    function test_loweredChoice_dropsPinsAndRotationFillsTheRest() public {
        _setPins(4);
        _setSize(6);
        _prepare(1);
        bytes32[] memory orgs = _orgIds(address(gov), token, 1);
        assertEq(orgs.length, 6);
        for (uint256 i; i < 4; ++i) {
            assertEq(orgs[i], _af(i));
        }
        _toEpoch(2);
        _setSize(2);
        gov.openEpoch(token, 2);
        orgs = _orgIds(address(gov), token, 2);
        assertEq(orgs.length, 2);
        assertEq(orgs[0], _af(0));
        assertEq(orgs[1], _af(1));
    }

    // ---- curated quotas at small sizes

    function _curate(uint16 bucket, uint8 count, uint16 weight)
        internal
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](count);
        for (uint256 r; r < count; ++r) {
            // Rank r picks the bucket's entry 10 + r.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32 index = uint32(10 + r);
            bytes32 org = bucket == AF ? _af(index) : _as(index);
            leaves[r] = keccak256(bytes.concat(keccak256(abi.encode(uint8(r), index, org))));
        }
        curations.set(bucket, CatalogTree.root(leaves), count, weight, 1);
    }

    function _curatedDraw(uint16 bucket, bytes32[] memory leaves, uint256 rank)
        internal
        view
        returns (IEpochGovernor.CuratedDraw memory d)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 index = uint32(10 + rank);
        uint256 e = cat.find(bucket, index);
        d.catalogIndex = index;
        d.pickOrgId = cat.entryAt(e).orgId;
        d.pickProof = CatalogTree.proof(leaves, rank);
        d.entryOrgId = d.pickOrgId;
        d.entryProof = cat.proofOf(e);
    }

    function _withCurators() internal {
        vm.prank(owner);
        gov.setCuratorRegistry(ICuratorRegistry(address(curations)));
    }

    /// @dev Pins that fill the ballot leave zero curated slots: no curated draw is consumed, so
    ///      `openEpoch` succeeds and a curated draw is one too many.
    function test_zeroFreeSlots_takesNoCuratedDraw() public {
        _withCurators();
        bytes32[] memory leaves = _curate(AF, 5, 1);
        _setSize(3);
        _setPins(3);
        IEpochGovernor.CuratedDraw[] memory one = new IEpochGovernor.CuratedDraw[](1);
        one[0] = _curatedDraw(AF, leaves, 0);
        vm.expectRevert(abi.encodeWithSelector(IEpochGovernor.TooManyCuratedDraws.selector, 1, 0));
        gov.prepareCuratedBallot(token, 1, one, new IEpochGovernor.Draw[](0));
        gov.openEpoch(token, 1);
        assertEq(_optionCount(1), 3);
    }

    /// @dev Size 2 with one pin: one slot for two equal-weight buckets. Floor shares are zero
    ///      and the leftover goes to the first bucket.
    function test_smallSize_curatedQuotaRoundsToTheFirstBucket() public {
        _withCurators();
        bytes32[] memory af = _curate(AF, 5, 1);
        _curate(AS, 5, 1);
        _setSize(2);
        _setPins(1);
        IEpochGovernor.CuratedDraw[] memory c = new IEpochGovernor.CuratedDraw[](1);
        c[0] = _curatedDraw(AF, af, 0);
        vm.expectEmit(true, true, false, true);
        emit IEpochGovernor.CuratedPicksUsed(token, 1, 1, 1);
        gov.prepareCuratedBallot(token, 1, c, new IEpochGovernor.Draw[](0));
        bytes32[] memory orgs = _orgIds(address(gov), token, 1);
        assertEq(orgs.length, 2);
        assertEq(orgs[0], _af(0));
        assertEq(orgs[1], _af(10));
    }
}
