// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {ICauseCatalog} from "../interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "../interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "../interfaces/IEpochGovernor.sol";

/// @title CatalogBallotLib
/// @notice How a ballot is built from the cause catalogue. Shared by the weekly epoch governor
///         and the live rotation governor, so both choose candidates the same way.
/// @dev A ballot of `size` slots for round `round` of `token` (a weekly epoch, or a live rotation
///      target) under catalogue version `version` is, in order:
///      1. the controller's pins (org ids proven in the token's focus when they were set),
///         skipping blocked causes;
///      2. curated picks: the free slots are split across the focus buckets' curations by weight
///         (`quotas`), and ranks `0..quota-1` of each bucket are taken in bucket order; a pick
///         whose catalogue entry is another org, or whose index is past the bucket, is skipped;
///      3. rotation draws over the focus pool: draw `k` is pool entry
///         `drawIndex(token, round, version, k, pool)`, skipping blocked causes and repeats, at
///         most `DRAW_FACTOR` draws per free slot. When the pool is no larger than the free
///         slots, the whole pool is walked in order instead.
///      The caller supplies every entry with its Merkle proof; the bucket, index and rank are
///      derived here, so whoever prepares a ballot has no say in what is on it. Errors are
///      `IEpochGovernor`'s; the rotation governor declares the same signatures.
library CatalogBallotLib {
    /// @dev Rotation gives up after `DRAW_FACTOR` draws per free slot (repeats are skipped).
    uint256 internal constant DRAW_FACTOR = 3;

    /// @dev Largest number of causes a controller may pin.
    uint8 internal constant PINNED_MAX = 8;

    /// @dev A ballot being built: cause ids (for repeats and events) and org ids (committed to or
    ///      stored), `n` filled out of `size`.
    struct Ballot {
        bytes32[] options;
        bytes32[] orgs;
        uint256 n;
        uint256 size;
    }

    /// @dev An empty ballot of `size` slots.
    function create(uint256 size) internal pure returns (Ballot memory b) {
        b.size = size;
        b.options = new bytes32[](size);
        b.orgs = new bytes32[](size);
    }

    /// @dev Appends `orgId` (cause id `causeId`).
    function push(Ballot memory b, bytes32 orgId, bytes32 causeId) internal pure {
        b.orgs[b.n] = orgId;
        b.options[b.n++] = causeId;
    }

    /// @dev Phase 1: the pins that fit, skipping blocked causes. Returns how many were added.
    function addPins(Ballot memory b, bytes32[] memory pins, ICauseRegistry registry)
        internal
        view
        returns (uint8 pinned)
    {
        for (uint256 i; i < pins.length && b.n < b.size; ++i) {
            bytes32 causeId = causeIdOf(pins[i]);
            if (registry.isBlocked(causeId)) continue;
            push(b, pins[i], causeId);
        }
        // Pins are capped at PINNED_MAX, which fits a uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        pinned = uint8(b.n);
    }

    /// @dev Non-empty focus buckets of `version` with their sizes, and the pool size (their sum).
    function focusPool(
        ICauseCatalog catalog,
        uint32 version,
        uint64 categoryMask,
        uint16 regionMask
    ) internal view returns (uint16[] memory buckets, uint32[] memory sizes, uint256 pool) {
        (buckets, sizes) = catalog.focusBuckets(version, categoryMask, regionMask);
        for (uint256 i; i < sizes.length; ++i) {
            pool += sizes[i];
        }
    }

    /// @dev Phase 2 over the curations `cs` of `buckets` (as `ICuratorRegistry.curationsFor`
    ///      returns them). Returns the curated draws consumed and how many were included.
    function curate(
        Ballot memory b,
        bytes32 root,
        ICauseRegistry registry,
        address token,
        uint256 round,
        uint16[] memory buckets,
        uint32[] memory sizes,
        ICuratorRegistry.Curation[] memory cs,
        IEpochGovernor.CuratedDraw[] memory curated
    ) internal view returns (uint256 k, uint256 included) {
        uint256[] memory q = quotas(b.size - b.n, cs);
        for (uint256 i; i < cs.length; ++i) {
            for (uint256 rank; rank < q[i]; ++rank) {
                if (k >= curated.length) {
                    revert IEpochGovernor.IncompleteCuratedBallot(token, round, k);
                }
                IEpochGovernor.CuratedDraw memory d = curated[k];
                if (!MerkleProof.verify(
                        d.pickProof, cs[i].picksRoot, pickLeaf(rank, d.catalogIndex, d.pickOrgId)
                    )) {
                    revert IEpochGovernor.InvalidCuratedDraw(k);
                }
                ++k;
                if (d.catalogIndex >= sizes[i]) continue;
                if (!MerkleProof.verify(
                        d.entryProof, root, leaf(buckets[i], d.catalogIndex, d.entryOrgId)
                    )) {
                    revert IEpochGovernor.InvalidCuratedDraw(k - 1);
                }
                if (d.entryOrgId != d.pickOrgId) continue;
                bytes32 causeId = causeIdOf(d.pickOrgId);
                if (
                    b.n >= b.size || registry.isBlocked(causeId)
                        || contains(b.options, b.n, causeId)
                ) {
                    continue;
                }
                push(b, d.pickOrgId, causeId);
                ++included;
            }
        }
    }

    /// @dev Slots per curation: `min(count, slots * weight / totalWeight)`, then leftovers one at a
    ///      time to buckets below their count, in order, round after round. Mirrors the SDK's
    ///      `curatedQuotas`.
    function quotas(uint256 slots, ICuratorRegistry.Curation[] memory cs)
        internal
        pure
        returns (uint256[] memory q)
    {
        q = new uint256[](cs.length);
        uint256 total;
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].count != 0) total += cs[i].weight;
        }
        if (slots == 0 || total == 0) return q;
        uint256 assigned;
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].count == 0 || cs[i].weight == 0) continue;
            uint256 share = (slots * cs[i].weight) / total;
            q[i] = share < cs[i].count ? share : cs[i].count;
            assigned += q[i];
        }
        uint256 rest = slots - assigned;
        while (rest != 0) {
            bool progressed;
            for (uint256 i; i < cs.length && rest != 0; ++i) {
                if (cs[i].weight != 0 && q[i] < cs[i].count) {
                    ++q[i];
                    --rest;
                    progressed = true;
                }
            }
            if (!progressed) break;
        }
    }

    /// @dev Phase 3: consumes draws until the ballot is full or the draw budget is spent. With a
    ///      pool no larger than the free slots, walks the whole pool in order instead. Returns the
    ///      number of draws consumed.
    function draw(
        Ballot memory b,
        bytes32 root,
        ICauseRegistry registry,
        address token,
        uint256 round,
        uint32 version,
        uint256 pool,
        uint16[] memory buckets,
        uint32[] memory sizes,
        IEpochGovernor.Draw[] memory draws
    ) internal view returns (uint256 k) {
        uint256 slots = b.size - b.n;
        bool sequential = pool <= slots;
        uint256 budget = sequential ? pool : DRAW_FACTOR * slots;
        for (; k < budget && b.n < b.size; ++k) {
            if (k >= draws.length) revert IEpochGovernor.IncompleteBallot(token, round, k);
            uint256 idx = sequential ? k : drawIndex(token, round, version, k, pool);
            (uint16 bucket, uint32 index) = locate(buckets, sizes, idx);
            bytes32 orgId = draws[k].orgId;
            if (!MerkleProof.verify(draws[k].proof, root, leaf(bucket, index, orgId))) {
                revert IEpochGovernor.InvalidDraw(k);
            }
            bytes32 causeId = causeIdOf(orgId);
            if (registry.isBlocked(causeId) || contains(b.options, b.n, causeId)) continue;
            push(b, orgId, causeId);
        }
    }

    /// @dev Truncates the ballot's arrays to the filled slots and returns them.
    function seal(Ballot memory b)
        internal
        pure
        returns (bytes32[] memory options, bytes32[] memory orgs)
    {
        options = b.options;
        orgs = b.orgs;
        uint256 n = b.n;
        assembly ("memory-safe") {
            mstore(options, n)
            mstore(orgs, n)
        }
    }

    /// @dev Distinct, unblocked entries of the latest catalogue version inside the focus, at most
    ///      `PINNED_MAX`. Returns their org ids and cause ids.
    function validatePins(
        ICauseCatalog catalog,
        ICauseRegistry registry,
        uint64 categoryMask,
        uint16 regionMask,
        IEpochGovernor.Pin[] calldata pins
    ) internal view returns (bytes32[] memory orgs, bytes32[] memory causes) {
        uint256 n = pins.length;
        if (n > PINNED_MAX) revert IEpochGovernor.InvalidShortlist();
        orgs = new bytes32[](n);
        causes = new bytes32[](n);
        if (n == 0) return (orgs, causes);
        uint32 version = catalog.latestVersion();
        if (version == 0) revert IEpochGovernor.NotInCatalog(pins[0].orgId);
        bytes32 root = catalog.rootOf(version);
        uint32[] memory sizes = catalog.bucketSizesOf(version);
        for (uint256 i; i < n; ++i) {
            IEpochGovernor.Pin calldata p = pins[i];
            if (!catalog.inFocus(p.bucket, categoryMask, regionMask)) {
                revert IEpochGovernor.OutOfFocus(p.orgId, p.bucket);
            }
            if (
                p.bucket >= sizes.length || p.index >= sizes[p.bucket]
                    || !MerkleProof.verifyCalldata(p.proof, root, leaf(p.bucket, p.index, p.orgId))
            ) revert IEpochGovernor.NotInCatalog(p.orgId);
            bytes32 causeId = causeIdOf(p.orgId);
            if (registry.isBlocked(causeId)) revert IEpochGovernor.InactiveCause(causeId);
            if (contains(causes, i, causeId)) revert IEpochGovernor.InvalidShortlist();
            causes[i] = causeId;
            orgs[i] = p.orgId;
        }
    }

    /// @dev Pool index of rotation draw `k` of `token`'s round `round`.
    function drawIndex(address token, uint256 round, uint32 version, uint256 k, uint256 poolSize)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(token, round, version, k))) % poolSize;
    }

    /// @dev Bucket and in-bucket index of pool entry `poolIndex` (which must be in the pool).
    function locate(uint16[] memory buckets, uint32[] memory sizes, uint256 poolIndex)
        internal
        pure
        returns (uint16, uint32)
    {
        uint256 rest = poolIndex;
        uint256 i;
        while (rest >= sizes[i]) {
            rest -= sizes[i];
            ++i;
        }
        // `rest < sizes[i]`, a uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (buckets[i], uint32(rest));
    }

    /// @dev Catalogue leaf (OpenZeppelin standard Merkle tree encoding).
    function leaf(uint16 bucket, uint32 index, bytes32 orgId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(bucket, index, orgId))));
    }

    /// @dev Curator pick leaf `(uint8 rank, uint32 catalogIndex, bytes32 orgId)`.
    function pickLeaf(uint256 rank, uint32 catalogIndex, bytes32 orgId)
        internal
        pure
        returns (bytes32)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        return keccak256(bytes.concat(keccak256(abi.encode(uint8(rank), catalogIndex, orgId))));
    }

    /// @dev Cause id of a catalogue org, as `CauseRegistry.causeIdOf`.
    function causeIdOf(bytes32 orgId) internal pure returns (bytes32) {
        return keccak256(abi.encode(orgId));
    }

    /// @dev Cause ids of `orgs`.
    function causeIds(bytes32[] memory orgs) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](orgs.length);
        for (uint256 i; i < out.length; ++i) {
            out[i] = causeIdOf(orgs[i]);
        }
    }

    /// @dev Whether `x` is among the first `n` entries of `list`.
    function contains(bytes32[] memory list, uint256 n, bytes32 x) internal pure returns (bool) {
        for (uint256 i; i < n; ++i) {
            if (list[i] == x) return true;
        }
        return false;
    }
}
