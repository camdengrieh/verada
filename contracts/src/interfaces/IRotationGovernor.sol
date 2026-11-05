// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

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
interface IRotationGovernor {
    /// @notice Status of the rotation poll for one target rotation.
    /// @dev `Applied`: the winner receives fees from `effectiveFrom`. `NoChange`: no ballots, or
    ///      no option received weight. `Stale`: a newer target was already applied. `InactiveWinner`:
    ///      the winning cause is no longer active in the cause registry.
    enum RoundStatus {
        None,
        Open,
        Closed,
        NoChange,
        Applied,
        Stale,
        InactiveWinner
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
    event ShortlistSet(address indexed token, bytes32[] causes);
    event DefaultShortlistSet(bytes32[] causes);
    event SchemeUpdated(address indexed scheme);
    event ParamsUpdated(Params params);
    event VaultSet(address indexed vault);
    event MinVotersSet(uint32 minVoters);

    // ---- events: rotation polls

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
    error NoShortlist(address token);
    error TooManyOptions(uint256 count, uint256 max);

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
    ///         schedule is anchored at the current time (rotation 0 starts now). Vault only.
    function registerToken(address token, bytes32 initialCause, RotationPeriod period) external;

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

    /// @notice The options a new round of `token` would use: its own shortlist, or the default.
    function shortlistOf(address token) external view returns (bytes32[] memory);

    /// @notice Whether `token` is registered.
    function isRegistered(address token) external view returns (bool);
}
