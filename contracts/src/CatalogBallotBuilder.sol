// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {CatalogBallotLib} from "./libraries/CatalogBallotLib.sol";

/// @title CatalogBallotBuilder
/// @notice Stateless runner of `CatalogBallotLib` for the rotation governor, which deploys it in
///         its constructor (it keeps the governor under the contract size limit). It builds a
///         ballot exactly as the weekly epoch governor does: pins, curated picks, rotation draws.
/// @dev Views only; reverts carry `IEpochGovernor`'s error signatures, which the rotation
///      governor bubbles unchanged.
contract CatalogBallotBuilder {
    using CatalogBallotLib for CatalogBallotLib.Ballot;

    ICauseCatalog public immutable catalog;
    ICauseRegistry public immutable registry;
    ITokenProfileRegistry public immutable profiles;

    /// @param token Token whose focus the pool is drawn from.
    /// @param round Round the draws are seeded with (the rotation target).
    /// @param version Catalogue version (zero: pins only).
    /// @param size Ballot slots.
    /// @param pins Pinned catalogue org ids, in order.
    /// @param curators Curator registry for the curated phase (zero: none).
    /// @param curationEpoch Weekly epoch of the curations.
    struct Request {
        address token;
        uint256 round;
        uint32 version;
        uint256 size;
        bytes32[] pins;
        ICuratorRegistry curators;
        uint256 curationEpoch;
    }

    /// @param orgs Option org ids, in ballot order.
    /// @param options Their cause ids.
    /// @param pinned Options that are pins (they come first).
    /// @param pool Focus pool size under `version`.
    /// @param curatedDrawn Curated draws consumed.
    /// @param curatedIncluded Curated picks on the ballot.
    struct Built {
        bytes32[] orgs;
        bytes32[] options;
        uint8 pinned;
        uint256 pool;
        uint256 curatedDrawn;
        uint256 curatedIncluded;
    }

    constructor(ICauseCatalog catalog_, ICauseRegistry registry_, ITokenProfileRegistry profiles_) {
        catalog = catalog_;
        registry = registry_;
        profiles = profiles_;
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
        uint256 used;
        if (q.version != 0) {
            (out.pool, out.curatedDrawn, out.curatedIncluded, used) = _fill(q, b, curated, draws);
        }
        if (curated.length != out.curatedDrawn) {
            revert IEpochGovernor.TooManyCuratedDraws(curated.length, out.curatedDrawn);
        }
        if (draws.length != used) revert IEpochGovernor.TooManyDraws(draws.length, used);
        (out.options, out.orgs) = b.seal();
    }

    function _fill(
        Request calldata q,
        CatalogBallotLib.Ballot memory b,
        IEpochGovernor.CuratedDraw[] calldata curated,
        IEpochGovernor.Draw[] calldata draws
    ) private view returns (uint256 pool, uint256 drawn, uint256 included, uint256 used) {
        (uint64 categoryMask, uint16 regionMask) = profiles.focusOf(q.token);
        uint16[] memory buckets;
        uint32[] memory sizes;
        (buckets, sizes, pool) =
            CatalogBallotLib.focusPool(catalog, q.version, categoryMask, regionMask);
        bytes32 root = catalog.rootOf(q.version);
        if (address(q.curators) != address(0) && b.n < b.size && buckets.length != 0) {
            ICuratorRegistry.Curation[] memory cs =
                q.curators.curationsFor(q.curationEpoch, q.version, buckets);
            (drawn, included) =
                b.curate(root, registry, q.token, q.round, buckets, sizes, cs, curated);
        }
        if (pool != 0 && b.n < b.size) {
            used = b.draw(root, registry, q.token, q.round, q.version, pool, buckets, sizes, draws);
        }
    }
}
