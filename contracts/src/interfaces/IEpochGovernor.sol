// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICuratorRegistry} from "./ICuratorRegistry.sol";

/// @title IEpochGovernor
/// @notice Weekly epochs in which token holders choose the cause receiving the cause pool.
/// @dev Each epoch of a token is a poll on the pluggable voting scheme. Its ballot is prepared at
///      the start of the epoch from the token's cause focus (fixed at launch) and the cause
///      catalogue version in effect at that time:
///      - up to `PINNED_MAX` causes pinned by the token's controller (its "shortlist"), each proven
///        to be a catalogue entry inside the focus;
///      - then curator agents' picks for the focus buckets, when published;
///      - the rest filled by rotation: draw `k` is pool entry
///        `keccak256(abi.encode(token, epoch, version, k)) % poolSize`, skipping blocked causes and
///        repeats, so over time every charity in the focus reaches a ballot. When the pool is not
///        larger than the free slots, the whole pool is taken in order.
///      Ballot size: the owner sets a protocol cap (`ballotSizeCap`, `MIN_OPTIONS..MAX_OPTIONS`,
///      `MAX_OPTIONS` by default) and a token's controller may choose its own size
///      (`setBallotSize`, zero to follow the cap). An epoch gets
///      `min(choice or cap, cap, scheme.MAX_OPTIONS())`. Pins and the size follow one timing rule:
///      both are read when the epoch's ballot is prepared, so a change applies to the current
///      epoch while its ballot is unprepared (nobody can vote before that) and otherwise from the
///      next epoch. A prepared ballot keeps its size (`ballotSizeFor`) and its option count
///      (`ballotCommitment`), which closing and finalizing use. Smaller ballots cost voters less:
///      the scheme packs three counters per encrypted tally word, so a ballot costs
///      `ceil(size / 3)` word updates and multiples of 3 waste no counter.
///      Anyone may prepare a ballot by supplying the entries and Merkle proofs for exactly those
///      draws (`prepareBallot`); the filler has no choice in what is drawn.
///      Voters do not call the governor: they call
///      `IVotingScheme.castBallot(address(governor), token, epoch, ballot)` on the scheme the epoch
///      was opened with, which calls back `authorizeBallot` so the governor can check eligibility
///      and return the voter's weight. Ballots are accepted only once the epoch is opened (by
///      `prepareBallot` or `openEpoch`), and their option index refers to the ballot order of
///      `BallotPrepared`. The governor stores only a commitment to that ballot
///      (`ballotCommitment`); finalizing an epoch with ballots takes the org ids back. Weight is
///      the voter's lowest vote checkpoint over the hold window
///      `[holdFromFor(token, epoch), snapshotFor(token, epoch)]`, in whole tokens. The snapshot is
///      `snapshotOf(epoch)` (the second before the epoch starts), except in the epoch a token
///      launches in, which predates the token and uses its `launchSnapshotOf` instead. The window
///      is `holdWindow()` (by default the whole previous epoch), so a position held only around
///      the public snapshot carries no weight. A token's launch epoch and the epoch after it start
///      the window at `launchSnapshotOf - min(launchSnapshotDelay, launch epoch end -
///      launchSnapshotOf) / 2` instead, the later half of the launch delay (fixed when the token
///      registered). Ballots are accepted only in the last `votingWindow()` of an epoch
///      (`votingOpensAt`); weights are fixed at the snapshot before the epoch starts, so trading
///      during the epoch's first phase cannot change that epoch's weights. The voter and weight are public; the choice
///      is as private as the scheme makes it.
interface IEpochGovernor {
    /// @notice A pinned cause: catalogue entry `(bucket, index, orgId)` and its Merkle proof
    ///         against the latest catalogue version.
    struct Pin {
        bytes32 orgId;
        uint16 bucket;
        uint32 index;
        bytes32[] proof;
    }

    /// @notice The catalogue entry at a rotation draw's pool index, with its Merkle proof. The
    ///         bucket and index are derived by the governor.
    struct Draw {
        bytes32 orgId;
        bytes32[] proof;
    }

    /// @notice A curated pick (bucket and rank derived by the governor): the pick leaf
    ///         `(rank, catalogIndex, pickOrgId)` with its proof against the agent's picks root, and
    ///         the catalogue entry actually at `(bucket, catalogIndex)` with its catalogue proof
    ///         (ignored when the index is past the bucket). The pick counts only when both orgs match.
    struct CuratedDraw {
        uint32 catalogIndex;
        bytes32 pickOrgId;
        bytes32[] pickProof;
        bytes32 entryOrgId;
        bytes32[] entryProof;
    }

    /// @notice Emitted when a vote is cast. `voteRef` is opaque so private schemes can replace it.
    event VoteCast(address indexed token, uint256 indexed epoch, bytes32 voteRef);

    /// @notice Emitted when an epoch is finalized with its winning cause.
    event EpochFinalized(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Emitted when an epoch's poll is opened with its frozen options.
    event EpochOpened(address indexed token, uint256 indexed epoch, bytes32[] options);

    /// @notice Emitted when a token registered in the epoch it was created in gets a launch
    ///         snapshot, at which the weights of that epoch are read.
    event LaunchSnapshotSet(address indexed token, uint256 indexed epoch, uint256 snapshot);

    /// @notice Emitted when an epoch's poll is closed and the tally requested.
    event EpochClosed(address indexed token, uint256 indexed epoch);

    /// @notice Emitted when an epoch with no ballots falls back to the default cause.
    event NoVoteFallbackApplied(address indexed token, uint256 indexed epoch, bytes32 causeId);

    /// @notice Emitted when an epoch with ballots falls back to the default cause because no
    ///         valid final tally arrived within `tallyGrace` after the epoch ended.
    event TallyTimeoutFallbackApplied(
        address indexed token, uint256 indexed epoch, bytes32 causeId
    );

    /// @notice Emitted when closing an epoch could not request the tally from its scheme (for
    ///         example because the scheme no longer lists this governor). `closeEpoch` may be
    ///         retried; otherwise the epoch falls back to the default cause after `tallyGrace`.
    event EpochCloseFailed(address indexed token, uint256 indexed epoch);

    /// @notice Emitted with every token shortlist change: the epoch from which `causes` apply.
    event ShortlistScheduled(
        address indexed token, uint256 indexed effectiveFrom, bytes32[] causes
    );

    /// @notice Emitted when an epoch's ballot is fixed: the options' catalogue org ids in ballot
    ///         order (cause id = `keccak256(orgId)`). `pinned` options come first, then curated
    ///         picks, then the rotation draws. This log is the only record of the org ids: the
    ///         governor keeps `ballotCommitment`, and `finalizeEpoch` of an epoch with ballots takes
    ///         them back. With fewer than `MIN_OPTIONS` options the epoch is not opened and finalizes
    ///         to the default cause.
    event BallotPrepared(
        address indexed token,
        uint256 indexed epoch,
        uint32 catalogVersion,
        uint256 poolSize,
        uint8 pinned,
        bytes32[] orgIds
    );

    event SchemeUpdated(address indexed scheme);
    /// @notice The epoch schedule changed: from epoch `startEpoch` (starting at `startTime`)
    ///         epochs last `length` seconds, ballots are accepted in the last `votingWindow`
    ///         seconds of each, and weights look back `holdWindow` seconds from the snapshot. Takes
    ///         effect from the next epoch, except before the first token registers, when it
    ///         re-anchors epoch zero (`startEpoch` 0).
    event EpochScheduleSet(
        uint256 startEpoch,
        uint256 startTime,
        uint256 length,
        uint256 votingWindow,
        uint256 holdWindow
    );
    /// @notice `tallyGrace` changed (applies immediately).
    event TallyGraceSet(uint256 grace);
    /// @notice `launchSnapshotDelay` changed (applies to tokens registered afterwards).
    event LaunchSnapshotDelaySet(uint256 delay);
    /// @notice `curationGrace` changed.
    event CurationGraceSet(uint256 grace);
    event CuratorRegistrySet(address curators);
    /// @notice No longer emitted (`requestCurationSkip` reverts); kept for indexers.
    event CurationSkipRequested(address indexed token, uint256 indexed epoch, uint256 skipAt);
    /// @notice Curated phase of a ballot: `drawn` picks checked, `included` of them on the ballot.
    event CuratedPicksUsed(
        address indexed token, uint256 indexed epoch, uint8 drawn, uint8 included
    );
    event FactorySet(address indexed factory);
    event DefaultCauseSet(bytes32 indexed causeId);
    event ShortlistSet(address indexed token, bytes32[] causes);
    /// @notice The protocol's largest ballot size changed. Also emitted at deployment.
    event BallotSizeCapSet(uint8 cap);
    /// @notice A token's controller chose its ballot size (zero: follow `ballotSizeCap`), applying
    ///         from epoch `effectiveFrom` (the current one when its ballot is not prepared yet).
    event BallotSizeSet(address indexed token, uint8 size, uint256 effectiveFrom);

    error NotFactory();
    error NotScheme(address caller);
    error NotController(address token, address caller);
    error TokenNotRegistered(address token);
    error EpochNotEnded(uint256 epoch);
    error EpochNotCurrent(uint256 epoch);
    /// @notice A ballot before the epoch's voting window opened at `opensAt`.
    error VotingNotOpen(uint256 epoch, uint256 opensAt);
    /// @notice A duration outside `[min, max]`.
    error DurationOutOfRange(uint256 value, uint256 min, uint256 max);
    error EpochNotOpened(address token, uint256 epoch);
    error EpochAlreadyOpened(address token, uint256 epoch);
    error EpochAlreadyClosed(address token, uint256 epoch);
    error EpochAlreadyFinalized(address token, uint256 epoch);
    error TallyNotFinal(address token, uint256 epoch);
    error InvalidTally(address token, uint256 epoch);
    /// @notice `finalizeEpoch` options do not match the ballot commitment.
    error BallotMismatch(address token, uint256 epoch);
    error InactiveCause(bytes32 causeId);
    error InvalidShortlist();
    error NoShortlist(address token);
    error NotInCatalog(bytes32 orgId);
    error OutOfFocus(bytes32 orgId, uint16 bucket);
    error BallotAlreadyPrepared(address token, uint256 epoch);
    /// @notice The ballot needs more draws than were supplied; `needed` is the next draw index.
    error IncompleteBallot(address token, uint256 epoch, uint256 needed);
    error TooManyDraws(uint256 supplied, uint256 used);
    error InvalidDraw(uint256 k);
    error PoolTooSmall(address token, uint256 poolSize);
    error IncompleteCuratedBallot(address token, uint256 epoch, uint256 needed);
    error TooManyCuratedDraws(uint256 supplied, uint256 used);
    error InvalidCuratedDraw(uint256 k);
    error CuratorRegistryAlreadySet();
    error CurationSkipAlreadyRequested(address token, uint256 epoch);
    /// @notice Published curations can no longer be skipped (`requestCurationSkip`).
    error CurationSkipDisabled(address token, uint256 epoch);
    error InvalidVote();
    error AlreadyVoted(address voter);
    error NoVotes(address token, uint256 epoch);
    error ZeroAddress();
    error FactoryAlreadySet();
    error InsufficientGas();
    /// @notice A ballot size outside `MIN_OPTIONS..MAX_OPTIONS` (zero is allowed for a token).
    error BallotSizeOutOfRange(uint256 size);
    /// @notice More pins than the token's current ballot size holds.
    error ShortlistTooLong(uint256 pins, uint256 size);

    // ------------------------------------------------------------------ constants / config

    /// @notice Shortest value of any owner-set duration (epoch, voting window, hold window,
    ///         graces).
    function MIN_DURATION() external view returns (uint256);

    /// @notice Longest value of any owner-set duration.
    function MAX_DURATION() external view returns (uint256);

    /// @notice Length in seconds of the current epoch (7 days by default). The length of any
    ///         epoch is `epochScheduleFor(epoch)`.
    function epochLength() external view returns (uint256);

    /// @notice Seconds at the end of the current epoch during which ballots are accepted (the
    ///         whole epoch by default). The remaining first part of the epoch is the trading phase.
    function votingWindow() external view returns (uint256);

    /// @notice Length of the hold window ending at the current epoch's snapshot (7 days by
    ///         default).
    function holdWindow() external view returns (uint256);

    /// @notice `(length, votingWindow, holdWindow)` in force for `epoch`. For the epoch after the
    ///         current one this is the schedule that will apply to it, including a pending change.
    function epochScheduleFor(uint256 epoch)
        external
        view
        returns (uint256 length, uint256 votingWindow, uint256 holdWindow);

    /// @notice Timestamp from which ballots of `epoch` are accepted: its end minus its voting
    ///         window. Ballots are accepted until the epoch ends.
    function votingOpensAt(uint256 epoch) external view returns (uint256);

    /// @notice Sets the epoch length, the voting window and the hold window, from the next epoch
    ///         (epochs already started keep their schedule). Before the first token registers it
    ///         applies at once, so the very first cycle can be short. Owner only.
    /// @param length Epoch length, `MIN_DURATION..MAX_DURATION`.
    /// @param votingWindow_ Final part of the epoch that accepts ballots, `MIN_DURATION..length`.
    /// @param holdWindow_ Hold window of the epochs' weights, `MIN_DURATION..MAX_DURATION`.
    function setEpochSchedule(uint256 length, uint256 votingWindow_, uint256 holdWindow_) external;

    /// @notice Sets `tallyGrace`. Owner only; applies at once.
    function setTallyGrace(uint256 grace) external;

    /// @notice Sets `launchSnapshotDelay`. Owner only; applies to tokens registered afterwards.
    function setLaunchSnapshotDelay(uint256 delay) external;

    /// @notice Sets `curationGrace`. Owner only.
    function setCurationGrace(uint256 grace) external;

    /// @notice Hard ceiling of every ballot size (further capped by the scheme's `MAX_OPTIONS`).
    function MAX_OPTIONS() external view returns (uint8);

    /// @notice Smallest ballot that opens a poll; also the smallest focus pool a token may launch
    ///         with.
    function MIN_OPTIONS() external view returns (uint8);

    /// @notice Largest number of causes a controller may pin.
    function PINNED_MAX() external view returns (uint8);

    /// @notice Rotation gives up after `DRAW_FACTOR` draws per free slot (repeats are skipped).
    function DRAW_FACTOR() external view returns (uint256);

    /// @notice Ballot size for epochs prepared now of a token that chose none:
    ///         `min(ballotSizeCap, scheme.MAX_OPTIONS())`. A token's own size is `ballotSizeFor`.
    function ballotSize() external view returns (uint256);

    /// @notice Protocol ballot size cap (`MIN_OPTIONS..MAX_OPTIONS`, owner-set, `MAX_OPTIONS` by
    ///         default). It bounds every token's ballot.
    function ballotSizeCap() external view returns (uint8);

    /// @notice The ballot size `token`'s controller chose (zero: follow `ballotSizeCap`). It may
    ///         exceed the cap, which then applies; the size in force is `ballotSizeFor`.
    function ballotSizeChoiceOf(address token) external view returns (uint8);

    /// @notice Ballot size of `token`'s `epoch`: the size it was prepared with, or for an
    ///         unprepared epoch the size it would get if prepared now,
    ///         `min(choice or ballotSizeCap, ballotSizeCap, scheme.MAX_OPTIONS())`. The ballot may
    ///         hold fewer options (`ballotCommitment`) when the pool is small.
    function ballotSizeFor(address token, uint256 epoch) external view returns (uint256);

    /// @notice Cause catalogue that ballots draw from.
    function catalog() external view returns (address);

    /// @notice Seconds after an epoch ends during which its final tally may still arrive; past
    ///         it, an epoch without a valid final tally finalizes to the default cause.
    function tallyGrace() external view returns (uint256);

    /// @notice Longest wait after a token's registration before its launch snapshot (shorter when
    ///         the launch epoch ends sooner: then halfway to its end).
    function launchSnapshotDelay() external view returns (uint256);

    /// @notice Former grace of `requestCurationSkip`. Kept for compatibility: a ballot with
    ///         usable curator picks now always needs its curated draws. Picks committed but
    ///         never served are dropped by the curator registry owner (`voidCurations`).
    function curationGrace() external view returns (uint256);

    /// @notice Timestamp at which epoch 0 starts.
    function epochZeroStart() external view returns (uint256);

    /// @notice Index of the current epoch.
    function currentEpoch() external view returns (uint256);

    /// @notice Start timestamp of `epoch`.
    function epochStart(uint256 epoch) external view returns (uint256);

    /// @notice Timestamp at which voting weights for `epoch` are read (the second before it starts,
    ///         so before the epoch's trading phase).
    function snapshotOf(uint256 epoch) external view returns (uint256);

    /// @notice Timestamp at which `token`'s voting weights for `epoch` are read: `snapshotOf(epoch)`,
    ///         or the token's launch snapshot in the epoch it launched in.
    function snapshotFor(address token, uint256 epoch) external view returns (uint256);

    /// @notice Launch snapshot of a token created in the epoch it was registered in (zero when the
    ///         token had supply at that epoch's snapshot and uses the regular one).
    function launchSnapshotOf(address token) external view returns (uint256);

    /// @notice Start of `token`'s hold window for `epoch`: weights are the lowest vote checkpoint
    ///         over `[holdFromFor, snapshotFor]`.
    function holdFromFor(address token, uint256 epoch) external view returns (uint256);

    /// @notice Voting scheme used for epochs opened from now on.
    function scheme() external view returns (address);

    /// @notice Cause that wins an epoch in which nobody voted (zero means no fallback).
    function defaultCause() external view returns (bytes32);

    /// @notice The token's pinned causes in effect for the current epoch.
    function shortlistOf(address token) external view returns (bytes32[] memory);
    /// @notice Pinned causes in effect for `epoch`. Exact for the current and later epochs; for a
    ///         prepared epoch its `BallotPrepared` options are authoritative.
    function shortlistFor(address token, uint256 epoch) external view returns (bytes32[] memory);
    /// @notice The token's pinned causes scheduled for a later epoch, and that epoch (zero when
    ///         nothing is scheduled). An empty list with a non-zero epoch schedules removing all pins.
    function pendingShortlistOf(address token)
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom);
    /// @notice Catalogue org ids of the pins in effect for `epoch`.
    function shortlistOrgIdsFor(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory);
    /// @notice Catalogue version and focus pool size an epoch's ballot draws from (the version in
    ///         effect at the epoch's start).
    function poolOf(address token, uint256 epoch)
        external
        view
        returns (uint32 version, uint256 poolSize);
    /// @notice Pool index of rotation draw `k` (see the contract notes).
    function drawIndex(address token, uint256 epoch, uint32 version, uint256 k, uint256 poolSize)
        external
        pure
        returns (uint256);

    // ------------------------------------------------------------------ admin

    /// @notice Registers a token for voting. Callable by the factory only, after the token's focus
    ///         is set; reverts `PoolTooSmall` unless the latest catalogue gives its focus at least
    ///         `MIN_OPTIONS` entries.
    function registerToken(address token) external;

    /// @notice Sets a token's pinned causes (0..PINNED_MAX distinct, unblocked catalogue entries
    ///         inside its focus, no more than its current ballot size) from the next epoch, or
    ///         from the current one if its ballot is not prepared yet. Callable by the token's
    ///         profile controller only. If the size is lowered later, a ballot takes only the
    ///         first `size` unblocked pins.
    function setShortlist(address token, Pin[] calldata pins) external;

    /// @notice Sets a token's ballot size: `MIN_OPTIONS..MAX_OPTIONS`, or zero to follow
    ///         `ballotSizeCap`. A choice above the cap gets the cap. Applies from the next epoch, or
    ///         from the current one if its ballot is not prepared yet (the pins' rule). Callable by
    ///         the token's profile controller only, like `setShortlist`.
    function setBallotSize(address token, uint8 size) external;

    /// @notice Sets the protocol ballot size cap (`MIN_OPTIONS..MAX_OPTIONS`). Owner only. It
    ///         bounds every token, including those that chose more, from each token's next
    ///         unprepared ballot; prepared ballots keep their size.
    function setBallotSizeCap(uint8 cap) external;

    // ------------------------------------------------------------------ lifecycle

    /// @notice Prepares and opens the current epoch's ballot for `token` (see the contract
    ///         notes). Permissionless. `draws` must be exactly the entries the rotation consumes.
    function prepareBallot(address token, uint256 epoch, Draw[] calldata draws) external;
    /// @notice `prepareBallot` with curated draws: the picks the curated phase consumes, in order,
    ///         then the rotation draws. Needed whenever the token's focus buckets have usable
    ///         curations for the epoch and its catalogue version: `prepareBallot` and `openEpoch`
    ///         (no curated draws) then revert `IncompleteCuratedBallot`, at any time.
    function prepareCuratedBallot(
        address token,
        uint256 epoch,
        CuratedDraw[] calldata curated,
        Draw[] calldata draws
    ) external;
    /// @notice Disabled: always reverts `CurationSkipDisabled`. Published curations cannot be
    ///         skipped; the curator registry owner voids picks nobody can get (`voidCurations`).
    function requestCurationSkip(address token, uint256 epoch) external;
    /// @notice Always 0 (`requestCurationSkip` is disabled). Kept for compatibility.
    function curationSkipAt(address token, uint256 epoch) external view returns (uint256);
    /// @notice Sets the curator registry. Owner only, once.
    function setCuratorRegistry(ICuratorRegistry curators_) external;
    /// @notice `prepareBallot` with no draws: works when the ballot needs none (empty pool, or
    ///         pins fill it). Permissionless. Ballots are rejected until the epoch is opened.
    function openEpoch(address token, uint256 epoch) external;

    /// @notice Closes an ended epoch's poll and asks the scheme for the tally. Permissionless. If
    ///         the scheme rejects the request the epoch is still marked closed (`EpochCloseFailed`)
    ///         and the call may be retried.
    function closeEpoch(address token, uint256 epoch) external;

    /// @notice Stores the winning cause of an ended epoch from the scheme's final tally, or the
    ///         default cause when nobody voted or when no valid final tally arrived within
    ///         `tallyGrace` of the epoch's end. Permissionless. Applying a tally needs the
    ///         ballot's org ids in order (`BallotPrepared`), checked against `ballotCommitment`
    ///         (`BallotMismatch` otherwise); without one they are ignored and may be empty.
    function finalizeEpoch(address token, uint256 epoch, bytes32[] calldata orgIds) external;

    // ------------------------------------------------------------------ epoch views

    /// @notice Whether the epoch's ballot has been prepared.
    function isPrepared(address token, uint256 epoch) external view returns (bool);
    /// @notice Commitment to the epoch's ballot, `keccak256(abi.encodePacked(orgIds))` over the
    ///         options' org ids in ballot order, and the option count (both zero if not prepared).
    ///         The org ids themselves are in `BallotPrepared`.
    function ballotCommitment(address token, uint256 epoch)
        external
        view
        returns (bytes32 commitment, uint8 optionCount);

    /// @notice Scheme the epoch was opened with (zero if not opened).
    function epochScheme(address token, uint256 epoch) external view returns (address);

    function isOpened(address token, uint256 epoch) external view returns (bool);
    function isClosed(address token, uint256 epoch) external view returns (bool);

    /// @notice Whether the last `closeEpoch` attempt failed to request the tally.
    function closeFailed(address token, uint256 epoch) external view returns (bool);

    /// @notice Whether the epoch has been finalized.
    function isFinalized(address token, uint256 epoch) external view returns (bool);

    /// @notice Winning cause of a finalized epoch (zero if not finalized).
    function winningCause(address token, uint256 epoch) external view returns (bytes32);

    /// @notice Final weight counted for a cause in a finalized epoch (zero when the cause was not on
    ///         the ballot or the epoch fell back to the default cause).
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256);

    /// @notice Whether `voter` cast a ballot in the epoch.
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool);

    /// @notice Number of ballots authorized in the epoch.
    function voterCount(address token, uint256 epoch) external view returns (uint256);

    /// @notice Voting weight of `account` in `epoch`: its lowest vote checkpoint over
    ///         `[holdFromFor(token, epoch), snapshotFor(token, epoch)]`, in whole tokens (zero
    ///         while the snapshot is still in the future).
    function weightOf(address token, uint256 epoch, address account) external view returns (uint64);

    /// @notice Reads at most `maxReads` more vote checkpoints of `account`'s hold window for
    ///         `epoch` and caches the progress, so a ballot over a window with very many
    ///         checkpoints fits in a block. Anyone may call it; it never changes a weight.
    /// @return done Whether the whole window has been read.
    function advanceHoldScan(address token, uint256 epoch, address account, uint256 maxReads)
        external
        returns (bool done);
}
