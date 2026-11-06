// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {CatalogBallotLib} from "./libraries/CatalogBallotLib.sol";

/// @title CatalogBallotBuilder
/// @notice Runner of `CatalogBallotLib` for the rotation governor, which deploys it in its
///         constructor (it keeps the governor under the contract size limit). It builds a
///         ballot exactly as the weekly epoch governor does: pins, curated picks, rotation draws,
///         under the weekly epoch's catalogue version and with the same curation grace.
/// @dev Views only, but for the governor's one-time `setCurators`. Ballot reverts carry
///      `IEpochGovernor`'s error signatures, which the rotation governor bubbles unchanged.
contract CatalogBallotBuilder {
    using CatalogBallotLib for CatalogBallotLib.Ballot;

    /// @notice Longest curation grace of a round, the weekly governor's `CURATION_GRACE`.
    uint256 public constant CURATION_GRACE = 6 hours;

    ICauseCatalog public immutable catalog;
    ICauseRegistry public immutable registry;
    ITokenProfileRegistry public immutable profiles;
    /// @notice The rotation governor that deployed this builder (it sets the curators).
    address public immutable governor;

    /// @notice Curator registry of the curated phase (unset: none), and its weekly clock.
    ICuratorRegistry public curators;
    uint64 public curationZero;
    uint64 public curationLength;

    error NotGovernor();
    error CuratorsAlreadySet();

    /// @param token Token whose focus the pool is drawn from.
    /// @param round Round the draws are seeded with (the rotation target).
    /// @param size Ballot slots.
    /// @param pins Pinned catalogue org ids, in order.
    /// @param voteStart The round's vote start (sets the version and curation epoch, `versionOf`).
    /// @param voteEnd The round's vote end (sets its curation grace, `curationGraceEnd`).
    struct Request {
        address token;
        uint256 round;
        uint256 size;
        bytes32[] pins;
        uint256 voteStart;
        uint256 voteEnd;
    }

    /// @param orgs Option org ids, in ballot order.
    /// @param options Their cause ids.
    /// @param pinned Options that are pins (they come first).
    /// @param pool Focus pool size under `version`.
    /// @param curatedDrawn Curated draws consumed.
    /// @param curatedIncluded Curated picks on the ballot.
    /// @param version Catalogue version of the ballot (zero: pins only).
    /// @param curationEpoch Weekly epoch whose curations were used (when `curatedDrawn != 0`).
    struct Built {
        bytes32[] orgs;
        bytes32[] options;
        uint8 pinned;
        uint256 pool;
        uint256 curatedDrawn;
        uint256 curatedIncluded;
        uint32 version;
        uint256 curationEpoch;
    }

    constructor(
        ICauseCatalog catalog_,
        ICauseRegistry causeRegistry,
        ITokenProfileRegistry profiles_
    ) {
        catalog = catalog_;
        registry = causeRegistry;
        profiles = profiles_;
        governor = msg.sender;
    }

    /// @notice Sets the curator registry and its weekly clock (`epochZeroStart`, `EPOCH_LENGTH`
    ///         of the epoch governor it follows). Once, by the governor.
    function setCurators(ICuratorRegistry curators_, uint256 zero, uint256 length) external {
        if (msg.sender != governor) revert NotGovernor();
        if (address(curators) != address(0)) revert CuratorsAlreadySet();
        curators = curators_;
        curationZero = SafeCast.toUint64(zero);
        curationLength = SafeCast.toUint64(length);
    }

    /// @notice Catalogue version of a round voting from `voteStart`, and the weekly curation epoch
    ///         containing it (`curatedPhase` false without a clock, `length == 0`, or before it).
    /// @dev With a curation epoch the version is the one the weekly ballots of that epoch use:
    ///      the version in effect at the epoch's start (`EpochGovernor` uses
    ///      `versionAt(epochStart(epoch))`). Curations are submitted during the epoch before with
    ///      a version no newer than that one and are only read under the version they carry, so a
    ///      version published mid-week would otherwise drop the week's curated phase from every
    ///      later round, and the round would differ from that week's weekly ballot. If no version
    ///      was in effect at the epoch's start, the weekly ballot has no curated phase and no
    ///      curation can carry a later version, so the version at `voteStart` is used instead: the
    ///      round still draws and its (empty) curated phase is the same. Without a curation epoch,
    ///      the version at `voteStart`.
    function versionOf(uint256 voteStart)
        public
        view
        returns (uint32 version, bool curatedPhase, uint256 epoch)
    {
        uint256 zero = curationZero;
        uint256 length = curationLength;
        if (length != 0 && voteStart >= zero) {
            curatedPhase = true;
            epoch = (voteStart - zero) / length;
            version = catalog.versionAt(zero + epoch * length);
        }
        if (version == 0) version = catalog.versionAt(voteStart);
    }

    /// @notice End of the curation grace of a round voting from `voteStart` to `voteEnd`.
    ///         Until then a round with usable curations needs its curated draws; after it,
    ///         ballots prepared without them skip the curated phase, while published curated
    ///         draws still apply (`build` applies the curated phase whenever curated draws are
    ///         given, as the weekly `prepareCuratedBallot`; the one difference is that an empty
    ///         `prepareCuratedRound` after the grace builds as `prepareRound` instead of
    ///         reverting).
    /// @dev The weekly governor waits `CURATION_GRACE` (6 hours) into the epoch for a ballot's
    ///      curated draws, so picks committed but never published cannot keep it closed. A round
    ///      waits from its vote start, the first moment it can be prepared, for
    ///      `min(CURATION_GRACE, (voteEnd - voteStart) / 3)`. The vote window is the period less
    ///      its close buffer `min(6 hours, period / 4)`, so this is exactly that close buffer:
    ///      the weekly 6 hours for daily and longer rotations, a quarter of the period for
    ///      shorter ones. Grace and close buffer then never take more than half the period (an
    ///      hourly round still votes for 30 minutes after a 15-minute grace), while every round
    ///      gives the curator's keeper the same window as a weekly epoch where that fits. It runs
    ///      from the round's own vote start, not the epoch's: a round voting late in the week
    ///      still gets its window to receive the published picks.
    function curationGraceEnd(uint256 voteStart, uint256 voteEnd) public pure returns (uint256) {
        uint256 grace = (voteEnd - voteStart) / 3;
        return voteStart + (grace < CURATION_GRACE ? grace : CURATION_GRACE);
    }

    /// @notice Validates `token`'s pins (`CatalogBallotLib.validatePins`).
    function validatePins(address token, IEpochGovernor.Pin[] calldata pins)
        external
        view
        returns (bytes32[] memory orgs, bytes32[] memory causes)
    {
        (uint64 categoryMask, uint16 regionMask) = profiles.focusOf(token);
        return CatalogBallotLib.validatePins(catalog, registry, categoryMask, regionMask, pins);
    }

    /// @notice Builds the ballot of `q` from `curated` and `draws`, which must be exactly the
    ///         curated and rotation draws the ballot consumes.
    function build(
        Request calldata q,
        IEpochGovernor.CuratedDraw[] calldata curated,
        IEpochGovernor.Draw[] calldata draws
    ) external view returns (Built memory out) {
        CatalogBallotLib.Ballot memory b = CatalogBallotLib.create(q.size);
        out.pinned = b.addPins(q.pins, registry);
        bool curatedPhase;
        (out.version, curatedPhase, out.curationEpoch) = versionOf(q.voteStart);
        // Curated draws always apply (`prepareCuratedRound`); without them, the curated phase
        // only during the grace.
        uint256 graceEnd = curationGraceEnd(q.voteStart, q.voteEnd);
        // forge-lint: disable-next-line(block-timestamp)
        bool curate = curated.length != 0 || block.timestamp < graceEnd;
        ICuratorRegistry cs = curatedPhase && curate ? curators : ICuratorRegistry(address(0));
        uint256 used;
        if (out.version != 0) {
            (out.pool, out.curatedDrawn, out.curatedIncluded, used) =
                _fill(q, out.version, out.curationEpoch, cs, b, curated, draws);
        }
        if (curated.length != out.curatedDrawn) {
            revert IEpochGovernor.TooManyCuratedDraws(curated.length, out.curatedDrawn);
        }
        if (draws.length != used) revert IEpochGovernor.TooManyDraws(draws.length, used);
        (out.options, out.orgs) = b.seal();
    }

    function _fill(
        Request calldata q,
        uint32 version,
        uint256 epoch,
        ICuratorRegistry curatorRegistry,
        CatalogBallotLib.Ballot memory b,
        IEpochGovernor.CuratedDraw[] calldata curated,
        IEpochGovernor.Draw[] calldata draws
    ) private view returns (uint256 pool, uint256 drawn, uint256 included, uint256 used) {
        (uint64 categoryMask, uint16 regionMask) = profiles.focusOf(q.token);
        uint16[] memory buckets;
        uint32[] memory sizes;
        (buckets, sizes, pool) =
            CatalogBallotLib.focusPool(catalog, version, categoryMask, regionMask);
        bytes32 root = catalog.rootOf(version);
        if (address(curatorRegistry) != address(0) && b.n < b.size && buckets.length != 0) {
            ICuratorRegistry.Curation[] memory cs =
                curatorRegistry.curationsFor(epoch, version, buckets);
            (drawn, included) =
                b.curate(root, registry, q.token, q.round, buckets, sizes, cs, curated);
        }
        if (pool != 0 && b.n < b.size) {
            used = b.draw(root, registry, q.token, q.round, version, pool, buckets, sizes, draws);
        }
    }
}
