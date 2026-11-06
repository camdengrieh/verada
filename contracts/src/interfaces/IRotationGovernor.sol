// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEpochGovernor} from "./IEpochGovernor.sol";

/// @notice Rotation length a live-donation token can use. Chosen by the creator at launch and
///         changeable later by a private holder vote.
enum RotationPeriod {
    OneHour,
    TwelveHours,
    OneDay,
    ThreeDays,
    OneWeek
}

/// @title IRotationGovernor
/// @notice Rotates the cause that receives a live-donation token's fees. Rotations follow an
///         anchor-based schedule; during rotation `n` holders vote privately (through the pluggable
///         voting scheme) on the cause for rotation `n + 1`. Holders can also change the rotation
///         period through a private yes/no proposal. With no result, the current cause continues.
/// @dev Candidates are chosen exactly as for a weekly ballot (`IEpochGovernor`,
///      `CatalogBallotLib`): the controller's pins (catalogue entries proven inside the token's
///      focus), then curated picks from the curator registry, then deterministic rotation draws
///      over the focus pool, under the catalogue version the weekly ballot of the epoch containing
///      the vote start uses (the version at the vote start without a curator clock). Anyone
///      prepares a round's ballot by supplying exactly the drawn entries with their Merkle proofs
///      (`prepareRound`, `prepareCuratedRound`); the ballot is frozen then, and ballots are
///      refused until it is. Only the winner is written to the cause registry. The pin, draw and
///      curated-pick structs are `IEpochGovernor`'s, and the views `poolOf`, `shortlistFor`,
///      `drawIndex`, `ballotSize` and `DRAW_FACTOR` have the weekly signatures, with the target
///      rotation in place of the epoch, so the same tooling fills both.
interface IRotationGovernor {
    /// @notice Status of the rotation poll for one target rotation.
    /// @dev `Applied`: the winner receives fees from `effectiveFrom`. `NoChange`: no ballots, or
    ///      no option received weight. `Stale`: a newer target was already applied. `InactiveWinner`:
    ///      the winning cause was blocked in the cause registry after the ballot was prepared.
    ///      `NoBallot`: the prepared ballot had fewer than `MIN_OPTIONS` options, so no poll was
    ///      opened. Every final status other than `Applied` keeps the current cause.
    enum RoundStatus {
        None,
        Open,
        Closed,
        NoChange,
        Applied,
        Stale,
        InactiveWinner,
        NoBallot
    }

    /// @notice State of a period-change proposal.
    enum ProposalState {
        None,
        Active,
        Ended,
        Closed,
        Defeated,
        Executed,
        Expired,
        Canceled
    }

    /// @notice Period-change proposal parameters, captured per proposal when it is created.
    /// @param votingPeriod Seconds a proposal accepts ballots.
    /// @param executionWindow Seconds after the vote ends within which the result can execute.
    /// @param cooldown Seconds after a proposal's vote end before the token can get a new one for
    ///        the same period (after a defeat or an expiry), or any new one (after an execution).
    /// @param quorumBps FOR weight needed, in basis points of the circulating supply.
    /// @param proposalThresholdBps Proposer weight needed, in basis points of the circulating supply.
    struct Params {
        uint32 votingPeriod;
        uint32 executionWindow;
        uint32 cooldown;
        uint16 quorumBps;
        uint16 proposalThresholdBps;
    }

    // ---- events: registration and configuration

    event TokenRegistered(
        address indexed token,
        bytes32 indexed initialCause,
        RotationPeriod period,
        uint256 anchorTime
    );
    /// @notice The token's pins (cause ids), used by every round prepared from now on.
    event ShortlistSet(address indexed token, bytes32[] causes);
    event SchemeUpdated(address indexed scheme);
    /// @notice Curator registry set; `epochZeroStart` and `epochLength` are its weekly clock.
    event CuratorRegistrySet(address curators, uint256 epochZeroStart, uint256 epochLength);
    event ParamsUpdated(Params params);
    event VaultSet(address indexed vault);
    event MinVotersSet(uint32 minVoters);

    // ---- events: rotation polls

    /// @notice A round's ballot is fixed. `pinned` options come first, then curated picks, then
    ///      rotation draws. With fewer than `MIN_OPTIONS` options the round is `NoBallot`.
    event BallotPrepared(
        address indexed token,
        uint64 indexed target,
        uint32 catalogVersion,
        uint256 poolSize,
        uint8 pinned,
        bytes32[] options
    );
    /// @notice Curated phase of a round: `drawn` picks checked, `included` of them on the ballot,
    ///         from the curations of weekly epoch `curationEpoch`.
    event CuratedPicksUsed(
        address indexed token,
        uint64 indexed target,
        uint256 curationEpoch,
        uint8 drawn,
        uint8 included
    );
    event RoundOpened(
        address indexed token,
        uint64 indexed target,
        uint256 scope,
        bytes32[] options,
        uint40 snapshot,
        uint40 voteEnd,
        address scheme
    );
    event RotationVoteCast(address indexed token, uint64 indexed target, bytes32 ballotRef);
    event RoundClosed(address indexed token, uint64 indexed target, bool tallyRequested);
    event RoundFinalized(
        address indexed token,
        uint64 indexed target,
        RoundStatus status,
        bytes32 winner,
        uint64 effectiveFrom
    );
    /// @notice `causeId` receives the token's fees from rotation `fromRotation`, which starts at
    ///         `startsAt`.
    event CauseScheduled(
        address indexed token, bytes32 indexed causeId, uint64 fromRotation, uint256 startsAt
    );

    // ---- events: period proposals

    event PeriodProposed(
        address indexed token,
        uint64 indexed id,
        address indexed proposer,
        RotationPeriod newPeriod,
        uint40 snapshot,
        uint40 end,
        uint64 quorumWeight
    );
    event PeriodVoteCast(address indexed token, uint64 indexed id, bytes32 ballotRef);
    event PeriodProposalClosed(uint64 indexed id, bool tallyRequested);
    /// @notice Only the outcome is revealed; FOR and AGAINST weights stay encrypted.
    event PeriodProposalTallied(uint64 indexed id, bool passed);
    event PeriodProposalExpired(uint64 indexed id);
    event PeriodChangeScheduled(
        address indexed token,
        uint64 indexed id,
        RotationPeriod newPeriod,
        uint64 fromRotation,
        uint256 switchAt
    );
    event PeriodProposalCanceled(uint64 indexed id);

    // ---- errors: registration and access

    error NotVault();
    error NotScheme(address caller);
    error NotController(address token, address caller);
    error NotProposer(address caller);
    error TokenNotRegistered(address token);
    error AlreadyRegistered(address token);
    error VaultAlreadySet();
    error ZeroAddress();

    // ---- errors: causes and shortlists

    error InactiveCause(bytes32 causeId);
    error InvalidShortlist();
    /// @notice The round was prepared with fewer than `MIN_OPTIONS` options, so it takes no
    ///         ballots.
    error NoShortlist(address token);

    // ---- errors: catalogue ballots (same signatures, so same selectors, as `IEpochGovernor`)

    error NotInCatalog(bytes32 orgId);
    error OutOfFocus(bytes32 orgId, uint16 bucket);
    error PoolTooSmall(address token, uint256 poolSize);
    /// @dev `round` is the target rotation.
    error IncompleteBallot(address token, uint256 round, uint256 needed);
    error TooManyDraws(uint256 supplied, uint256 used);
    error InvalidDraw(uint256 k);
    /// @dev `round` is the target rotation.
    error IncompleteCuratedBallot(address token, uint256 round, uint256 needed);
    error TooManyCuratedDraws(uint256 supplied, uint256 used);
    error InvalidCuratedDraw(uint256 k);
    error CuratorRegistryAlreadySet();
    /// @notice The curator registry has no weekly clock (its epoch governor is not set).
    error CuratorClockNotSet();

    // ---- errors: rounds

    error RoundNotCurrent(uint64 target);
    error RoundNotOpened(address token, uint64 target);
    error RoundAlreadyOpened(address token, uint64 target);
    error RoundAlreadyClosed(address token, uint64 target);
    error RoundNotClosed(address token, uint64 target);
    error VotingClosed();
    error VotingNotEnded();

    // ---- errors: tallies and ballots

    error TallyNotFinal();
    error InvalidTally();
    error InvalidVote();
    error AlreadyVoted(address voter);
    error InvalidScope(uint256 scope);

    // ---- errors: proposals

    error ProposalPending(uint64 id);
    error CooldownActive(uint256 until);
    error SamePeriod();
    error NoCirculatingSupply();
    error BelowProposalThreshold(uint64 weight, uint256 required);
    error UnknownProposal(uint64 id);
    error NotClosable(uint64 id, ProposalState state);
    error NotExecutable(uint64 id, ProposalState state);
    error NotCancelable(uint64 id, ProposalState state);
    /// @notice A proposal that already received a ballot cannot be canceled.
    error ProposalHasBallots(uint64 id);
    error InvalidParams();

    // ---- registration

    /// @notice Registers a live-donation token with its initial cause and rotation period. The
    ///         schedule is anchored at the current time (rotation 0 starts now). The token's focus
    ///         must give the latest catalogue at least `MIN_OPTIONS` entries, as for a weekly
    ///         token. Vault only.
    function registerToken(address token, bytes32 initialCause, RotationPeriod period) external;

    // ---- ballots

    /// @notice Sets `token`'s pins: up to `PINNED_MAX` distinct, unblocked entries of the latest
    ///         catalogue version inside the token's focus, each with its Merkle proof. Empty
    ///         clears them. They apply to every round prepared from now on; prepared rounds keep
    ///         their ballot. Profile controller only.
    function setShortlist(address token, IEpochGovernor.Pin[] calldata pins) external;

    /// @notice Prepares and opens the poll for rotation `target` of `token` (the next rotation)
    ///         from the pins and `draws`: exactly the rotation draws the governor derives, each
    ///         with its catalogue proof. Permissionless; once per round, during its vote window.
    ///         A round with usable curations reverts `IncompleteCuratedBallot` here (and in
    ///         `openRound`) for its whole vote window: it needs `prepareCuratedRound`.
    function prepareRound(address token, uint64 target, IEpochGovernor.Draw[] calldata draws)
        external;

    /// @notice As `prepareRound`, with the curated picks taken before the rotation draws (the
    ///         curations of weekly epoch `curationEpochOf(token, target)`), at any time in the
    ///         vote window.
    function prepareCuratedRound(
        address token,
        uint64 target,
        IEpochGovernor.CuratedDraw[] calldata curated,
        IEpochGovernor.Draw[] calldata draws
    ) external;

    // ---- views (O(1), never revert, zero values for unknown tokens)

    /// @notice Cause receiving `token`'s fees now, and the current rotation index.
    function activeCause(address token) external view returns (bytes32 causeId, uint64 rotation);

    /// @notice Cause receiving `token`'s fees at `ts`. Exact for the current and future rotations
    ///         (as currently scheduled); history is in the events.
    function activeCauseAt(address token, uint256 ts) external view returns (bytes32);

    /// @notice Current rotation index of `token`.
    function currentRotation(address token) external view returns (uint64);

    /// @notice Rotation index of `token` at `ts` (exact for `ts` at or after the stored anchor).
    function rotationAt(address token, uint256 ts) external view returns (uint64);

    /// @notice Start time of rotation `n` of `token` (exact for `n` at or after the stored anchor).
    function rotationStart(address token, uint64 n) external view returns (uint256);

    /// @notice Current period of `token`, and the pending change if one is scheduled.
    function periodOf(address token)
        external
        view
        returns (RotationPeriod current, bool pending, RotationPeriod next, uint64 fromRotation);

    /// @notice Snapshot and voting window of the rotation poll for `target` (computed from the
    ///         current schedule; an opened round stores its own copy).
    function pollWindow(address token, uint64 target)
        external
        view
        returns (uint40 snapshot, uint40 voteStart, uint40 voteEnd);

    /// @notice The rotation poll for `target`.
    function roundOf(address token, uint64 target)
        external
        view
        returns (
            RoundStatus status,
            uint40 snapshot,
            uint40 voteEnd,
            uint32 voters,
            bytes32 winner,
            uint64 effectiveFrom,
            bytes32[] memory options
        );

    /// @notice State of period-change proposal `id`.
    function proposalState(uint64 id) external view returns (ProposalState);

    /// @notice Cause ids of `token`'s pins (the first options of every round prepared now).
    function shortlistOf(address token) external view returns (bytes32[] memory);

    /// @notice Cause ids of the pins a round `target` prepared now would start with.
    function shortlistFor(address token, uint256 target) external view returns (bytes32[] memory);

    /// @notice Catalogue version and focus pool size of round `target`: as stored once prepared,
    ///         otherwise the version its weekly epoch's ballots use (in effect at that epoch's
    ///         start), or the one in effect at its vote start when that is zero or there is no
    ///         curator clock (zero values if none).
    function poolOf(address token, uint256 target)
        external
        view
        returns (uint32 version, uint256 poolSize);

    /// @notice Pool index of rotation draw `k` of round `target` (as `IEpochGovernor.drawIndex`).
    function drawIndex(address token, uint256 target, uint32 version, uint256 k, uint256 poolSize)
        external
        pure
        returns (uint256);

    /// @notice Options a round prepared now holds at most: `min(MAX_OPTIONS, scheme.MAX_OPTIONS())`.
    function ballotSize() external view returns (uint256);

    /// @notice Weekly epoch whose curations feed round `target` (the one containing its vote
    ///         start); `ok` is false without a curator registry or a schedule for `target`.
    function curationEpochOf(address token, uint256 target)
        external
        view
        returns (bool ok, uint256 epoch);

    /// @notice Whether `token` is registered.
    function isRegistered(address token) external view returns (bool);
}
