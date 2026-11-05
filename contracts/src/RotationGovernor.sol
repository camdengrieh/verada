// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "./interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";
import {PollScopeLib} from "./libraries/PollScopeLib.sol";
import {RotationScheduleLib} from "./libraries/RotationScheduleLib.sol";

/// @title RotationGovernor
/// @notice Picks, rotation by rotation, the cause that receives a live-donation token's fees, and
///         lets holders change the rotation period. Both decisions are private polls on the
///         pluggable `IVotingScheme`; this contract owns eligibility and weights.
/// @dev Schedule. Each token has an anchor-based schedule (`RotationScheduleLib`): rotation 0 starts
///      at registration, and a period change only ever applies from the next boundary, so rotation
///      indices, poll scopes and snapshots never collide across period changes.
///
///      Rotation polls. During rotation `c`, holders vote on the cause for `target = c + 1` among the
///      token's shortlist (or the default shortlist), frozen when the round opens. The snapshot is
///      `start(c) - 1`, before the poll can open, so tokens bought during the rotation carry no
///      weight (no buy-vote-sell, no flash loans). The poll closes `closeBuffer` before rotation
///      `target` starts, leaving time to decrypt, submit and finalize the tally. A result
///      finalized after `target` started applies from the next boundary instead, never
///      retroactively. With no ballots, or no result yet, the current cause keeps receiving fees;
///      there is no fallback cause. Rounds are plurality with no quorum (ties go to the lowest
///      option index).
///
///      Period proposals. Any holder above the proposal threshold can propose a new period. The
///      yes/no poll uses the snapshot `start(c) - 1`; quorum is a share of the circulating supply
///      at that snapshot (total supply minus the pool manager's checkpoint, which holds the pool
///      liquidity and never votes). A passed proposal schedules the period from the next boundary
///      and replaces any change not yet in effect. One active proposal per token, then a cooldown.
///
///      Scopes. Poll scopes are `PollScopeLib.encode(kind, id)`: rotation polls use the target
///      rotation, proposals use a global proposal id, and the kinds keep them disjoint.
///
///      Invariants:
///       - G1/G2/G7: see `RotationScheduleLib`.
///       - G3: the active cause of rotation `n` is fixed once `n` started (`effectiveFrom > current`).
///       - G4: the active cause is the initial cause or the winner of an `Applied` round.
///       - G5: one ballot per voter per poll; weights are vote checkpoints at a snapshot strictly
///         before the poll could open, so their sum is at most the past total supply.
///       - G8: `lastAppliedTarget` is monotonic and `effectiveFrom >= rotationAt(finalize) + 1`.
///
///      Reentrancy: the only external calls are to the owner-set scheme (`open`, `requestTally`,
///      `tallyOf`, `MAX_OPTIONS`), the cause registry and the token's vote checkpoints. The scheme
///      re-enters `authorizeBallot` from `castBallot` by design, and this contract re-enters the
///      scheme's `open` from there for lazily opened rounds; state is written before `open` is
///      called. The swap path only reads `activeCause`.
contract RotationGovernor is IRotationGovernor, IBallotGovernor, Ownable2Step {
    using RotationScheduleLib for RotationScheduleLib.Schedule;

    /// @notice Most options a rotation poll may have (further capped by the scheme).
    uint8 public constant MAX_OPTIONS = 10;
    /// @notice Fewest options a shortlist may have.
    uint8 public constant MIN_OPTIONS = 2;
    /// @notice Option index of AGAINST in a period proposal.
    uint8 public constant OPTION_AGAINST = 0;
    /// @notice Option index of FOR in a period proposal.
    uint8 public constant OPTION_FOR = 1;

    uint256 internal constant BPS = 10_000;
    uint32 internal constant MIN_VOTING_PERIOD = 1 hours;
    uint32 internal constant MAX_VOTING_PERIOD = 7 days;
    uint32 internal constant MIN_EXECUTION_WINDOW = 1 hours;
    uint32 internal constant MAX_EXECUTION_WINDOW = 14 days;
    uint32 internal constant MAX_COOLDOWN = 30 days;
    uint16 internal constant MIN_QUORUM_BPS = 100;
    uint16 internal constant MAX_QUORUM_BPS = 5000;

    uint8 internal constant FLAG_CLOSED = 1;
    uint8 internal constant FLAG_DEFEATED = 2;
    uint8 internal constant FLAG_EXECUTED = 4;
    uint8 internal constant FLAG_EXPIRED = 8;
    uint8 internal constant FLAG_CANCELED = 16;

    /// @notice Cause registry (active checks for shortlists and winners).
    ICauseRegistry public immutable causeRegistry;
    /// @notice Profile registry; a token's controller sets its shortlist.
    ITokenProfileRegistry public immutable profileRegistry;
    /// @notice Uniswap v4 pool manager, excluded from the circulating supply.
    address public immutable poolManager;

    /// @notice Cause state of a token (3 slots).
    /// @param current Cause receiving fees until `nextFrom` (or indefinitely without `hasNext`).
    /// @param next Cause receiving fees from rotation `nextFrom`.
    struct CauseState {
        bytes32 current;
        bytes32 next;
        uint64 nextFrom;
        uint64 lastAppliedTarget;
        bool hasNext;
        bool registered;
    }

    /// @notice Rotation poll for one target rotation.
    struct Round {
        IVotingScheme scheme;
        uint40 snapshot;
        uint40 voteEnd;
        RoundStatus status;
        uint32 voters;
        uint64 effectiveFrom;
        bytes32 winner;
        bytes32[] options;
        mapping(address voter => bool) voted;
    }

    /// @notice Period-change proposal (4 slots).
    struct PeriodProposal {
        address token;
        RotationPeriod newPeriod;
        uint8 flags;
        uint40 snapshot;
        uint40 end;
        address proposer;
        uint40 executionDeadline;
        uint32 voters;
        IVotingScheme scheme;
        uint64 quorumWeight;
        uint64 forWeight;
        uint64 againstWeight;
        uint64 fromRotation;
    }

    IVotingScheme internal _scheme;
    /// @notice The live-donation vault, the only registrar (set once).
    address public vault;
    Params internal _params;
    /// @notice Number of period proposals ever created (ids start at 1).
    uint64 public proposalCount;
    bytes32[] internal _defaultShortlist;

    mapping(address token => RotationScheduleLib.Schedule) internal _schedules;
    mapping(address token => CauseState) internal _causes;
    mapping(address token => bytes32[]) internal _shortlists;
    mapping(address token => mapping(uint64 target => Round)) internal _rounds;
    mapping(uint64 id => PeriodProposal) internal _proposals;
    mapping(uint64 id => mapping(address voter => bool)) internal _periodVoted;
    /// @notice The token's proposal that has not reached a final state (0 if none).
    mapping(address token => uint64 id) public activeProposalOf;
    /// @notice Vote end of the token's latest proposal (start of its cooldown).
    mapping(address token => uint40) public lastProposalEnd;

    /// @param initialOwner Admin: scheme, params, default shortlist, vault (once).
    /// @param causeRegistry_ Cause registry.
    /// @param profileRegistry_ Token profile registry (shortlist authority).
    /// @param poolManager_ Uniswap v4 pool manager.
    /// @param scheme_ Initial voting scheme.
    /// @param params_ Initial period-proposal parameters.
    constructor(
        address initialOwner,
        ICauseRegistry causeRegistry_,
        ITokenProfileRegistry profileRegistry_,
        address poolManager_,
        IVotingScheme scheme_,
        Params memory params_
    ) Ownable(initialOwner) {
        if (
            address(causeRegistry_) == address(0) || address(profileRegistry_) == address(0)
                || poolManager_ == address(0) || address(scheme_) == address(0)
        ) revert ZeroAddress();
        causeRegistry = causeRegistry_;
        profileRegistry = profileRegistry_;
        poolManager = poolManager_;
        _scheme = scheme_;
        _setParams(params_);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the vault, the only account allowed to register tokens. Once.
    function setVault(address vault_) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadySet();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Replaces the voting scheme for polls opened from now on. Open polls keep theirs.
    function setScheme(IVotingScheme scheme_) external onlyOwner {
        if (address(scheme_) == address(0)) revert ZeroAddress();
        _scheme = scheme_;
        emit SchemeUpdated(address(scheme_));
    }

    /// @notice Sets the parameters of period proposals created from now on.
    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    /// @notice Sets the shortlist used by tokens without their own. Empty clears it.
    function setDefaultShortlist(bytes32[] calldata causes) external onlyOwner {
        if (causes.length != 0) _validateShortlist(causes);
        _defaultShortlist = causes;
        emit DefaultShortlistSet(causes);
    }

    /// @notice Sets `token`'s shortlist (2 to `maxOptions()` distinct active causes). Empty
    ///         clears it, so the default applies. Profile controller only. Rounds already open
    ///         keep the options they were opened with.
    function setShortlist(address token, bytes32[] calldata causes) external {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
        if (causes.length != 0) _validateShortlist(causes);
        _shortlists[token] = causes;
        emit ShortlistSet(token, causes);
    }

    // ------------------------------------------------------------------ registration

    /// @inheritdoc IRotationGovernor
    function registerToken(address token, bytes32 initialCause, RotationPeriod period) external {
        if (msg.sender != vault) revert NotVault();
        CauseState storage cs = _causes[token];
        if (cs.registered) revert AlreadyRegistered(token);
        if (initialCause == bytes32(0) || !causeRegistry.isActive(initialCause)) {
            revert InactiveCause(initialCause);
        }
        _schedules[token] = RotationScheduleLib.Schedule({
            // forge-lint: disable-next-line(unsafe-typecast)
            anchorTime: uint40(block.timestamp),
            anchorIndex: 0,
            period: period,
            hasPending: false,
            pendingPeriod: RotationPeriod.OneHour,
            pendingFrom: 0
        });
        cs.current = initialCause;
        cs.registered = true;
        emit TokenRegistered(token, initialCause, period, block.timestamp);
    }

    // ------------------------------------------------------------------ rotation polls

    /// @notice Opens the poll for the next rotation of `token`. Permissionless; a poll also opens
    ///         lazily on its first ballot.
    /// @return target The rotation the poll decides.
    function openRound(address token) external returns (uint64 target) {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        RotationScheduleLib.Schedule memory s = _schedules[token];
        target = s.indexAt(block.timestamp) + 1;
        if (_rounds[token][target].status != RoundStatus.None) {
            revert RoundAlreadyOpened(token, target);
        }
        _openRound(token, target, s);
    }

    /// @inheritdoc IBallotGovernor
    /// @dev Called by the scheme during the voter's `castBallot`. Dispatches on the scope kind.
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64 weight)
    {
        (uint8 kind, uint64 id) = PollScopeLib.decode(scope);
        if (kind == PollScopeLib.KIND_ROTATION) {
            return _authorizeRotation(token, id, voter, ballotRef);
        }
        return _authorizePeriod(token, scope, id, voter, ballotRef);
    }

    /// @notice Closes the poll for `target` once voting ended. Without ballots the round ends as
    ///         `NoChange`; otherwise the scheme is asked to reveal the tally. Permissionless.
    function closeRound(address token, uint64 target) external {
        Round storage r = _rounds[token][target];
        RoundStatus st = r.status;
        if (st == RoundStatus.None) revert RoundNotOpened(token, target);
        if (st != RoundStatus.Open) revert RoundAlreadyClosed(token, target);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < r.voteEnd) revert VotingNotEnded();

        if (r.voters == 0) {
            r.status = RoundStatus.NoChange;
            emit RoundClosed(token, target, false);
            emit RoundFinalized(token, target, RoundStatus.NoChange, bytes32(0), 0);
            return;
        }
        r.status = RoundStatus.Closed;
        r.scheme.requestTally(token, PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target));
        emit RoundClosed(token, target, true);
    }

    /// @notice Applies the revealed tally of `target`. Permissionless.
    /// @dev The winner is the strict argmax (ties to the lowest index). It applies from the
    ///      rotation after the current one: `target` when finalized on time, later otherwise.
    ///      A round older than the last applied one is recorded as `Stale`.
    function finalizeRound(address token, uint64 target) external {
        Round storage r = _rounds[token][target];
        if (r.status != RoundStatus.Closed) revert RoundNotClosed(token, target);
        (bool isFinal, uint64[] memory counts) = r.scheme
            .tallyOf(address(this), token, PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target));
        if (!isFinal) revert TallyNotFinal();
        bytes32[] storage options = r.options;
        uint256 n = options.length;
        if (counts.length != n) revert InvalidTally();

        uint256 best;
        bytes32 winner;
        for (uint256 i; i < n; ++i) {
            if (counts[i] > best) {
                best = counts[i];
                winner = options[i];
            }
        }

        CauseState storage cs = _causes[token];
        RoundStatus status;
        uint64 effectiveFrom;
        if (best == 0) {
            status = RoundStatus.NoChange;
        } else if (target <= cs.lastAppliedTarget) {
            status = RoundStatus.Stale;
        } else if (!causeRegistry.isActive(winner)) {
            status = RoundStatus.InactiveWinner;
        } else {
            RotationScheduleLib.Schedule memory s = _schedules[token];
            uint64 c = s.indexAt(block.timestamp);
            // Materialize a scheduled cause that is already in effect.
            if (cs.hasNext && c >= cs.nextFrom) {
                cs.current = cs.next;
                cs.hasNext = false;
            }
            // Never retroactive: the earliest rotation that has not started yet. When
            // `cs.hasNext` survives here, `c + 1 == nextFrom`, so only the same boundary is
            // overwritten.
            effectiveFrom = c + 1;
            cs.next = winner;
            cs.nextFrom = effectiveFrom;
            cs.hasNext = true;
            cs.lastAppliedTarget = target;
            status = RoundStatus.Applied;
            emit CauseScheduled(token, winner, effectiveFrom, s.startOf(effectiveFrom));
        }

        r.status = status;
        r.winner = winner;
        r.effectiveFrom = effectiveFrom;
        emit RoundFinalized(token, target, status, winner, effectiveFrom);
    }

    // ------------------------------------------------------------------ period proposals

    /// @notice Proposes changing `token`'s rotation period to `newPeriod` from the next boundary
    ///         after execution.
    /// @dev Requires a nonzero weight at the snapshot that also meets the proposal threshold, no
    ///      other active proposal for the token and an elapsed cooldown. Not possible in rotation
    ///      0 (the snapshot predates the token, so there is no circulating supply).
    /// @return id The proposal id.
    function proposePeriod(address token, RotationPeriod newPeriod) external returns (uint64 id) {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        uint64 pending = activeProposalOf[token];
        if (pending != 0) revert ProposalPending(pending);
        Params memory p = _params;
        uint256 until = uint256(lastProposalEnd[token]) + p.cooldown;
        // forge-lint: disable-next-line(block-timestamp)
        if (lastProposalEnd[token] != 0 && block.timestamp < until) revert CooldownActive(until);

        RotationScheduleLib.Schedule memory s = _schedules[token];
        uint64 c = s.indexAt(block.timestamp);
        if (s.periodOf(c + 1) == newPeriod) revert SamePeriod();
        uint256 snapshot = s.startOf(c) - 1;

        uint256 circulating = _circulating(token, snapshot);
        if (circulating == 0) revert NoCirculatingSupply();
        uint64 weight = _weightAt(token, snapshot, msg.sender);
        uint256 required = (circulating * p.proposalThresholdBps) / BPS;
        if (weight == 0 || weight < required) revert BelowProposalThreshold(weight, required);
        uint64 quorumWeight =
            SafeCast.toUint64(FullMath.mulDivRoundingUp(circulating, p.quorumBps, BPS));

        id = ++proposalCount;
        uint40 end = SafeCast.toUint40(block.timestamp + p.votingPeriod);
        IVotingScheme sch = _scheme;
        PeriodProposal storage pp = _proposals[id];
        pp.token = token;
        pp.newPeriod = newPeriod;
        pp.snapshot = SafeCast.toUint40(snapshot);
        pp.end = end;
        pp.proposer = msg.sender;
        pp.executionDeadline = end + p.executionWindow;
        pp.scheme = sch;
        pp.quorumWeight = quorumWeight;
        activeProposalOf[token] = id;
        lastProposalEnd[token] = end;

        sch.open(token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id), 2);
        emit PeriodProposed(token, id, msg.sender, newPeriod, pp.snapshot, end, quorumWeight);
    }

    /// @notice Closes an ended proposal: without ballots it is defeated, otherwise the scheme is
    ///         asked to reveal the tally. Permissionless.
    function closePeriodProposal(uint64 id) external {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (st != ProposalState.Ended) revert NotClosable(id, st);
        if (p.voters == 0) {
            p.flags |= FLAG_CLOSED | FLAG_DEFEATED;
            delete activeProposalOf[p.token];
            emit PeriodProposalClosed(id, false);
            emit PeriodProposalTallied(id, 0, 0, false);
            return;
        }
        p.flags |= FLAG_CLOSED;
        p.scheme.requestTally(p.token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id));
        emit PeriodProposalClosed(id, true);
    }

    /// @notice Applies the revealed tally of a closed proposal. Permissionless.
    /// @dev Passes with `for >= quorumWeight && for > against`. A passed proposal executed within
    ///      its window schedules the new period from the next boundary. Without a final tally it
    ///      reverts `TallyNotFinal` until the window ends, then expires.
    /// @return executed Whether the period change was scheduled.
    function executePeriodProposal(uint64 id) external returns (bool executed) {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (st != ProposalState.Closed) revert NotExecutable(id, st);
        address token = p.token;

        (bool isFinal, uint64[] memory counts) = p.scheme
        .tallyOf(address(this), token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id));
        // forge-lint: disable-next-line(block-timestamp)
        bool late = block.timestamp > p.executionDeadline;
        if (!isFinal) {
            if (!late) revert TallyNotFinal();
            p.flags |= FLAG_EXPIRED;
            delete activeProposalOf[token];
            emit PeriodProposalExpired(id);
            return false;
        }
        if (counts.length != 2) revert InvalidTally();
        uint64 forWeight = counts[OPTION_FOR];
        uint64 againstWeight = counts[OPTION_AGAINST];
        p.forWeight = forWeight;
        p.againstWeight = againstWeight;
        bool passed = forWeight >= p.quorumWeight && forWeight > againstWeight;

        if (!passed) {
            p.flags |= FLAG_DEFEATED;
        } else if (late) {
            p.flags |= FLAG_EXPIRED;
            emit PeriodProposalExpired(id);
        } else {
            RotationScheduleLib.Schedule memory s =
                RotationScheduleLib.schedule(_schedules[token], block.timestamp, p.newPeriod);
            _schedules[token] = s;
            p.fromRotation = s.pendingFrom;
            p.flags |= FLAG_EXECUTED;
            executed = true;
            emit PeriodChangeScheduled(token, id, p.newPeriod, s.pendingFrom, s.switchAt());
        }
        delete activeProposalOf[token];
        emit PeriodProposalTallied(id, forWeight, againstWeight, passed);
    }

    /// @notice Cancels an active proposal. Proposer only.
    function cancelPeriodProposal(uint64 id) external {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (msg.sender != p.proposer) revert NotProposer(msg.sender);
        if (st != ProposalState.Active) revert NotCancelable(id, st);
        p.flags |= FLAG_CANCELED;
        delete activeProposalOf[p.token];
        emit PeriodProposalCanceled(id);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IRotationGovernor
    function activeCause(address token) external view returns (bytes32 causeId, uint64 rotation) {
        CauseState storage cs = _causes[token];
        if (!cs.registered) return (bytes32(0), 0);
        rotation = _schedules[token].indexAt(block.timestamp);
        causeId = (cs.hasNext && rotation >= cs.nextFrom) ? cs.next : cs.current;
    }

    /// @inheritdoc IRotationGovernor
    function activeCauseAt(address token, uint256 ts) external view returns (bytes32) {
        CauseState storage cs = _causes[token];
        if (!cs.registered) return bytes32(0);
        uint64 n = _rotationAt(_schedules[token], ts);
        return (cs.hasNext && n >= cs.nextFrom) ? cs.next : cs.current;
    }

    /// @inheritdoc IRotationGovernor
    function currentRotation(address token) external view returns (uint64) {
        if (!_causes[token].registered) return 0;
        return _schedules[token].indexAt(block.timestamp);
    }

    /// @inheritdoc IRotationGovernor
    /// @dev Times before the stored anchor (folded in by a period change) clamp to the anchor.
    function rotationAt(address token, uint256 ts) external view returns (uint64) {
        if (!_causes[token].registered) return 0;
        return _rotationAt(_schedules[token], ts);
    }

    /// @inheritdoc IRotationGovernor
    /// @dev Returns 0 for rotations before the stored anchor.
    function rotationStart(address token, uint64 n) external view returns (uint256) {
        if (!_causes[token].registered) return 0;
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (n < s.anchorIndex) return 0;
        return s.startOf(n);
    }

    /// @inheritdoc IRotationGovernor
    function periodOf(address token)
        external
        view
        returns (RotationPeriod current, bool pending, RotationPeriod next, uint64 fromRotation)
    {
        if (!_causes[token].registered) {
            return (RotationPeriod.OneHour, false, RotationPeriod.OneHour, 0);
        }
        RotationScheduleLib.Schedule memory s = _schedules[token];
        uint64 c = s.indexAt(block.timestamp);
        current = s.periodOf(c);
        if (s.hasPending && s.pendingFrom > c) {
            return (current, true, s.pendingPeriod, s.pendingFrom);
        }
        return (current, false, current, 0);
    }

    /// @inheritdoc IRotationGovernor
    /// @dev Zero for unknown tokens, `target == 0` and targets before the stored anchor.
    function pollWindow(address token, uint64 target)
        external
        view
        returns (uint40 snapshot, uint40 voteStart, uint40 voteEnd)
    {
        if (!_causes[token].registered || target == 0) return (0, 0, 0);
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (target - 1 < s.anchorIndex) return (0, 0, 0);
        return _window(s, target);
    }

    /// @inheritdoc IRotationGovernor
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
        )
    {
        Round storage r = _rounds[token][target];
        return (r.status, r.snapshot, r.voteEnd, r.voters, r.winner, r.effectiveFrom, r.options);
    }

    /// @notice Scheme a round was opened with (zero if never opened).
    function roundScheme(address token, uint64 target) external view returns (address) {
        return address(_rounds[token][target].scheme);
    }

    /// @notice Whether `voter` was authorized in the rotation poll for `target`.
    function hasVotedRound(address token, uint64 target, address voter)
        external
        view
        returns (bool)
    {
        return _rounds[token][target].voted[voter];
    }

    /// @inheritdoc IRotationGovernor
    function proposalState(uint64 id) external view returns (ProposalState) {
        return _state(_proposals[id]);
    }

    /// @notice Period-change proposal `id` (zeroed if unknown).
    function getProposal(uint64 id) external view returns (PeriodProposal memory) {
        return _proposals[id];
    }

    /// @notice Whether `voter` was authorized in proposal `id`.
    function hasVotedProposal(uint64 id, address voter) external view returns (bool) {
        return _periodVoted[id][voter];
    }

    /// @notice Whole-token weight of `account` at `snapshot` (zero while the snapshot is not past).
    function weightAt(address token, uint256 snapshot, address account)
        external
        view
        returns (uint64)
    {
        return _weightAt(token, snapshot, account);
    }

    /// @inheritdoc IRotationGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        bytes32[] storage own = _shortlists[token];
        return own.length != 0 ? own : _defaultShortlist;
    }

    /// @notice The default shortlist.
    function defaultShortlist() external view returns (bytes32[] memory) {
        return _defaultShortlist;
    }

    /// @inheritdoc IRotationGovernor
    function isRegistered(address token) external view returns (bool) {
        return _causes[token].registered;
    }

    /// @notice Current cause state of `token` (as stored; see `activeCause` for the live view).
    function causeStateOf(address token) external view returns (CauseState memory) {
        return _causes[token];
    }

    /// @notice The voting scheme used for new polls.
    function scheme() external view returns (address) {
        return address(_scheme);
    }

    /// @notice Parameters for new period proposals.
    function params() external view returns (Params memory) {
        return _params;
    }

    /// @notice Largest option count a new round may have: `min(MAX_OPTIONS, scheme.MAX_OPTIONS())`.
    function maxOptions() public view returns (uint256) {
        return _maxOptions(_scheme);
    }

    // ------------------------------------------------------------------ internals

    function _openRound(address token, uint64 target, RotationScheduleLib.Schedule memory s)
        private
    {
        (uint40 snapshot,, uint40 voteEnd) = _window(s, target);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= voteEnd) revert VotingClosed();
        bytes32[] storage source =
            _shortlists[token].length != 0 ? _shortlists[token] : _defaultShortlist;
        uint256 n = source.length;
        if (n == 0) revert NoShortlist(token);
        IVotingScheme sch = _scheme;
        uint256 max = _maxOptions(sch);
        if (n > max) revert TooManyOptions(n, max);

        Round storage r = _rounds[token][target];
        r.scheme = sch;
        r.snapshot = snapshot;
        r.voteEnd = voteEnd;
        r.status = RoundStatus.Open;
        r.options = source;
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
        // Bounded by MAX_OPTIONS above, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        sch.open(token, scope, uint8(n));
        emit RoundOpened(token, target, scope, r.options, snapshot, voteEnd, address(sch));
    }

    function _authorizeRotation(address token, uint64 target, address voter, bytes32 ballotRef)
        private
        returns (uint64 weight)
    {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (target != s.indexAt(block.timestamp) + 1) revert RoundNotCurrent(target);

        Round storage r = _rounds[token][target];
        bool fresh = r.status == RoundStatus.None;
        address expected = fresh ? address(_scheme) : address(r.scheme);
        if (msg.sender != expected) revert NotScheme(msg.sender);
        if (fresh) _openRound(token, target, s);
        // forge-lint: disable-next-line(block-timestamp)
        else if (r.status != RoundStatus.Open || block.timestamp >= r.voteEnd) revert VotingClosed();

        if (r.voted[voter]) revert AlreadyVoted(voter);
        weight = _weightAt(token, r.snapshot, voter);
        if (weight == 0) revert InvalidVote();
        r.voted[voter] = true;
        unchecked {
            ++r.voters;
        }
        emit RotationVoteCast(token, target, ballotRef);
    }

    function _authorizePeriod(
        address token,
        uint256 scope,
        uint64 id,
        address voter,
        bytes32 ballotRef
    ) private returns (uint64 weight) {
        PeriodProposal storage p = _proposals[id];
        if (p.token == address(0) || p.token != token) revert InvalidScope(scope);
        if (msg.sender != address(p.scheme)) revert NotScheme(msg.sender);
        if (_state(p) != ProposalState.Active) revert VotingClosed();
        if (_periodVoted[id][voter]) revert AlreadyVoted(voter);
        weight = _weightAt(token, p.snapshot, voter);
        if (weight == 0) revert InvalidVote();
        _periodVoted[id][voter] = true;
        unchecked {
            ++p.voters;
        }
        emit PeriodVoteCast(token, id, ballotRef);
    }

    function _state(PeriodProposal storage p) private view returns (ProposalState) {
        if (p.token == address(0)) return ProposalState.None;
        uint8 f = p.flags;
        if (f & FLAG_CANCELED != 0) return ProposalState.Canceled;
        if (f & FLAG_EXECUTED != 0) return ProposalState.Executed;
        if (f & FLAG_EXPIRED != 0) return ProposalState.Expired;
        if (f & FLAG_DEFEATED != 0) return ProposalState.Defeated;
        if (f & FLAG_CLOSED != 0) return ProposalState.Closed;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.end) return ProposalState.Active;
        return ProposalState.Ended;
    }

    /// @dev Snapshot `start(target - 1) - 1`, voting from `start(target - 1)` until
    ///      `start(target) - closeBuffer(period of target - 1)`. Requires `target - 1 >= anchorIndex`.
    function _window(RotationScheduleLib.Schedule memory s, uint64 target)
        private
        pure
        returns (uint40 snapshot, uint40 voteStart, uint40 voteEnd)
    {
        uint256 start = s.startOf(target - 1);
        uint256 end = s.startOf(target) - RotationScheduleLib.closeBuffer(s.periodOf(target - 1));
        snapshot = SafeCast.toUint40(start - 1);
        voteStart = SafeCast.toUint40(start);
        voteEnd = SafeCast.toUint40(end);
    }

    function _rotationAt(RotationScheduleLib.Schedule memory s, uint256 ts)
        private
        pure
        returns (uint64)
    {
        if (ts < s.anchorTime) return s.anchorIndex;
        return s.indexAt(ts);
    }

    function _maxOptions(IVotingScheme sch) private view returns (uint256) {
        uint256 m = sch.MAX_OPTIONS();
        return m < MAX_OPTIONS ? m : MAX_OPTIONS;
    }

    /// @dev Whole tokens outside the pool manager at `snapshot` (which must be in the past).
    function _circulating(address token, uint256 snapshot) private view returns (uint256) {
        uint256 total = IVotes(token).getPastTotalSupply(snapshot);
        uint256 pooled = IVotes(token).getPastVotes(poolManager, snapshot);
        return total > pooled ? (total - pooled) / 1e18 : 0;
    }

    /// @dev Whole-token vote checkpoint of `account` at `snapshot`, capped to 64 bits; zero while
    ///      the snapshot is not yet in the past (same rule as the epoch governor).
    function _weightAt(address token, uint256 snapshot, address account)
        private
        view
        returns (uint64)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) return 0;
        uint256 whole = IVotes(token).getPastVotes(account, snapshot) / 1e18;
        // Capped just above, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
    }

    /// @dev MIN_OPTIONS..maxOptions() nonzero, active, distinct causes.
    function _validateShortlist(bytes32[] calldata causes) private view {
        uint256 n = causes.length;
        if (n < MIN_OPTIONS || n > _maxOptions(_scheme)) revert InvalidShortlist();
        for (uint256 i; i < n; ++i) {
            bytes32 causeId = causes[i];
            if (causeId == bytes32(0)) revert InvalidShortlist();
            if (!causeRegistry.isActive(causeId)) revert InactiveCause(causeId);
            for (uint256 j; j < i; ++j) {
                if (causes[j] == causeId) revert InvalidShortlist();
            }
        }
    }

    function _setParams(Params memory p) private {
        if (
            p.votingPeriod < MIN_VOTING_PERIOD || p.votingPeriod > MAX_VOTING_PERIOD
                || p.executionWindow < MIN_EXECUTION_WINDOW
                || p.executionWindow > MAX_EXECUTION_WINDOW || p.cooldown > MAX_COOLDOWN
                || p.quorumBps < MIN_QUORUM_BPS || p.quorumBps > MAX_QUORUM_BPS
                || p.proposalThresholdBps > p.quorumBps
        ) revert InvalidParams();
        _params = p;
        emit ParamsUpdated(p);
    }
}
