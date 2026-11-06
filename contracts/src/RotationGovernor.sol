// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

import {CatalogBallotBuilder} from "./CatalogBallotBuilder.sol";
import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IRotationGovernor, RotationPeriod} from "./interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {
    IBallotGovernor,
    IOutcomeVotingScheme,
    IVotingScheme,
    NO_WINNER
} from "./interfaces/IVotingScheme.sol";
import {CatalogBallotLib} from "./libraries/CatalogBallotLib.sol";
import {PollScopeLib} from "./libraries/PollScopeLib.sol";
import {RotationScheduleLib} from "./libraries/RotationScheduleLib.sol";

/// @dev Vote checkpoint accessors of `ERC20TimestampVotes` (live tokens are `VeradaToken`s).
interface ICheckpointVotes {
    function numCheckpoints(address account) external view returns (uint32);
    function checkpoints(address account, uint32 pos)
        external
        view
        returns (uint48 key, uint208 value);
}

/// @dev `CuratorRegistry`'s weekly clock: the epoch governor its curations follow.
interface ICuratorClock {
    function governor() external view returns (address);
}

/// @title RotationGovernor
/// @notice Picks, rotation by rotation, the cause that receives a live-donation token's fees, and
///         lets holders change the rotation period. Both decisions are private polls on the
///         pluggable `IVotingScheme`; this contract owns eligibility and weights.
/// @dev Schedule. Each token has an anchor-based schedule (`RotationScheduleLib`): rotation 0 starts
///      at registration, and a period change only ever applies from the next boundary, so rotation
///      indices, poll scopes and snapshots never collide across period changes.
///
///      Weights. A voter's weight is the lowest vote checkpoint it had over the whole hold window
///      `[snapshot - lookback, snapshot]`, with `snapshot = start(c) - 1` (before the poll can
///      open) and `lookback = max(length of rotation c, 1 day)`. Tokens bought during the
///      rotation carry no weight, and neither does a position held only around the (public)
///      snapshot instant: it must be held through the whole window (no buy-vote-sell, no flash
///      loans, no one-block holds). Polls of a token's first day therefore carry no weight.
///
///      Rotation polls. During rotation `c`, holders vote on the cause for `target = c + 1`. The
///      round's ballot is built exactly like a weekly ballot (`CatalogBallotLib`, see
///      `IRotationGovernor`): the controller's pins, then curated picks (the curator registry's
///      curations for the weekly epoch containing the vote start), then deterministic rotation
///      draws over the token's focus pool, skipping blocked causes. All of it uses the catalogue
///      version the weekly ballot of that epoch uses (in effect at the epoch's start; see
///      `CatalogBallotBuilder.versionOf`), so a round includes curated picks exactly when that
///      weekly ballot does. Unpublished picks hold a round only for its curation grace
///      (`CatalogBallotBuilder.curationGraceEnd`), as the weekly `CURATION_GRACE` holds an
///      epoch. Anyone prepares it with the drawn entries
///      and their proofs (`prepareRound`); it is frozen then and never built inside a ballot, so
///      a ballot's option index always refers to a list fixed by an earlier transaction. A
///      round never prepared, or prepared with fewer than `MIN_OPTIONS` options (`NoBallot`),
///      takes no ballots. The poll closes `closeBuffer` before rotation `target` starts, leaving
///      time to decrypt, submit and finalize the result. Only the winner is materialized into
///      the cause registry. A result finalized after `target` started applies from the next
///      boundary instead, never retroactively. With fewer than `minVoters` ballots, or no result
///      yet, the current cause keeps receiving fees; there is no fallback cause. Rounds are
///      plurality with no quorum (ties go to the lowest option index).
///
///      Privacy. Polls are closed with `requestOutcome`: only the winning option index is ever
///      decrypted, never per-option counts (which give individual choices away in small polls
///      whose weights are public). A poll below `minVoters` is not decrypted at all.
///
///      Period proposals. Any holder above the proposal threshold can propose a new period. The
///      yes/no poll uses the hold window ending at `start(c) - 1`; quorum is a share of the
///      circulating supply at that snapshot (total supply minus the pool manager's checkpoint,
///      which holds the pool liquidity and never votes). A passed proposal schedules the period
///      from the next boundary and replaces any change not yet in effect. Proposals for different
///      periods may run side by side (one active per token and period), so no holder can block
///      the others by occupying a single slot. A proposal can be canceled only before its first
///      ballot, and canceling starts no cooldown. A defeat or expiry starts a cooldown for that
///      period; an execution starts it for every period, and any older proposal still pending
///      is superseded (it expires instead of executing).
///
///      Scopes. Poll scopes are `PollScopeLib.encode(kind, id)`: rotation polls use the target
///      rotation, proposals use a global proposal id, and the kinds keep them disjoint.
///
///      Invariants:
///       - G1/G2/G7: see `RotationScheduleLib`.
///       - G3: the active cause of rotation `n` is fixed once `n` started (`effectiveFrom > current`).
///       - G4: the active cause is the initial cause or the winner of an `Applied` round.
///       - G5: one ballot per voter per poll; a weight is the lowest vote checkpoint over a hold
///         window ending strictly before the poll could open, so the sum is at most the past
///         total supply at the snapshot.
///       - G8: `lastAppliedTarget` is monotonic and `effectiveFrom >= rotationAt(finalize) + 1`.
///
///      Reentrancy: the only external calls are to the owner-set scheme (`open`, `requestOutcome`,
///      `outcomeOf`, `MAX_OPTIONS`), the cause registry (`materialize` only for a winner), the
///      catalogue, the owner-set curator registry (views) and the token's vote checkpoints. The
///      scheme re-enters `authorizeBallot` from `castBallot` by design; that path never opens a
///      poll. Round state is written before the scheme's `open` is called. The swap path only
///      reads `activeCause`.
contract RotationGovernor is IRotationGovernor, IBallotGovernor, Ownable2Step {
    using RotationScheduleLib for RotationScheduleLib.Schedule;

    /// @notice Most options a rotation poll may have (further capped by the scheme).
    uint8 public constant MAX_OPTIONS = 10;
    /// @notice Fewest options a round needs to open, and a focus pool at registration.
    uint8 public constant MIN_OPTIONS = 2;
    /// @notice Most causes a controller may pin (as weekly).
    uint8 public constant PINNED_MAX = CatalogBallotLib.PINNED_MAX;
    /// @notice Rotation draws per free slot before giving up (as weekly).
    uint256 public constant DRAW_FACTOR = CatalogBallotLib.DRAW_FACTOR;
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
    /// @notice Shortest hold window a weight is measured over.
    uint256 public constant MIN_HOLD_LOOKBACK = 1 days;
    /// @notice Most checkpoints read inside a hold window (newest first); older ones are covered
    ///         by the window-start checkpoint only. Bounds the cost of a ballot.
    uint256 public constant MAX_HOLD_SCAN = 128;
    /// @notice Largest `minVoters`.
    uint32 public constant MAX_MIN_VOTERS = 100;

    uint8 internal constant FLAG_CLOSED = 1;
    uint8 internal constant FLAG_DEFEATED = 2;
    uint8 internal constant FLAG_EXECUTED = 4;
    uint8 internal constant FLAG_EXPIRED = 8;
    uint8 internal constant FLAG_CANCELED = 16;

    /// @notice Cause registry: blocked causes are skipped, winners are materialized into it.
    ICauseRegistry public immutable causeRegistry;
    /// @notice Profile registry: a token's controller (pins) and focus.
    ITokenProfileRegistry public immutable profileRegistry;
    ICauseCatalog internal immutable _catalog;
    /// @notice Runs `CatalogBallotLib` for this governor (deployed by its constructor).
    CatalogBallotBuilder public immutable ballotBuilder;
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
        IOutcomeVotingScheme scheme;
        uint40 snapshot;
        uint40 voteEnd;
        RoundStatus status;
        uint32 voters;
        uint64 effectiveFrom;
        /// @dev Start of the hold window (`snapshot - lookback`).
        uint40 holdFrom;
        uint32 catalogVersion;
        uint64 poolSize;
        bytes32 winner;
        /// @dev Catalogue org ids of the options, in ballot order.
        bytes32[] options;
        mapping(address voter => bool) voted;
    }

    /// @notice Period-change proposal (4 slots). FOR and AGAINST weights are never revealed.
    struct PeriodProposal {
        address token;
        RotationPeriod newPeriod;
        uint8 flags;
        uint40 snapshot;
        uint40 end;
        address proposer;
        uint40 executionDeadline;
        uint32 voters;
        IOutcomeVotingScheme scheme;
        uint64 quorumWeight;
        uint64 fromRotation;
        /// @dev Start of the hold window (`snapshot - lookback`).
        uint40 holdFrom;
        /// @dev `executions[token]` when proposed; a later execution supersedes this proposal.
        uint32 executionsAtProposal;
    }

    IOutcomeVotingScheme internal _scheme;
    /// @notice The live-donation vault, the only registrar (set once).
    address public vault;
    Params internal _params;
    /// @notice Number of period proposals ever created (ids start at 1).
    uint64 public proposalCount;
    /// @notice Curator agents' weekly picks (unset: no curated phase).
    ICuratorRegistry public curators;

    mapping(address token => RotationScheduleLib.Schedule) internal _schedules;
    mapping(address token => CauseState) internal _causes;
    /// @dev Pinned catalogue org ids.
    mapping(address token => bytes32[]) internal _shortlists;
    mapping(address token => mapping(uint64 target => Round)) internal _rounds;
    mapping(uint64 id => PeriodProposal) internal _proposals;
    mapping(uint64 id => mapping(address voter => bool)) internal _periodVoted;
    /// @notice Fewest ballots a poll needs to be decrypted; below it the poll changes nothing.
    uint32 public minVoters;
    /// @notice The token's proposal for `period` that has not reached a final state (0 if none).
    mapping(address token => mapping(RotationPeriod period => uint64 id)) public activeProposalOf;
    /// @notice Vote end of the token's latest defeated or expired proposal for `period` (start of
    ///         that period's cooldown). Canceled proposals never set it.
    mapping(address token => mapping(RotationPeriod period => uint40)) public lastProposalEnd;
    /// @notice Vote end of the token's latest executed proposal (start of the cooldown of every
    ///         period).
    mapping(address token => uint40) public lastExecutedEnd;
    /// @notice Number of executed period changes of the token (supersedes older proposals).
    mapping(address token => uint32) public executions;

    /// @param initialOwner Admin: scheme, params, minVoters, vault and curator registry (once).
    /// @param causeRegistry_ Cause registry (this governor must be one of its materializers).
    /// @param catalog_ Cause catalogue.
    /// @param profileRegistry_ Token profile registry (pin authority and focus).
    /// @param poolManager_ Uniswap v4 pool manager.
    /// @param scheme_ Initial voting scheme.
    /// @param params_ Initial period-proposal parameters.
    constructor(
        address initialOwner,
        ICauseRegistry causeRegistry_,
        ICauseCatalog catalog_,
        ITokenProfileRegistry profileRegistry_,
        address poolManager_,
        IOutcomeVotingScheme scheme_,
        Params memory params_
    ) Ownable(initialOwner) {
        if (
            address(causeRegistry_) == address(0) || address(catalog_) == address(0)
                || address(profileRegistry_) == address(0) || poolManager_ == address(0)
                || address(scheme_) == address(0)
        ) revert ZeroAddress();
        causeRegistry = causeRegistry_;
        _catalog = catalog_;
        ballotBuilder = new CatalogBallotBuilder(catalog_, causeRegistry_, profileRegistry_);
        profileRegistry = profileRegistry_;
        poolManager = poolManager_;
        _scheme = scheme_;
        _setParams(params_);
        minVoters = 1;
        emit MinVotersSet(1);
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
    function setScheme(IOutcomeVotingScheme scheme_) external onlyOwner {
        if (address(scheme_) == address(0)) revert ZeroAddress();
        _scheme = scheme_;
        emit SchemeUpdated(address(scheme_));
    }

    /// @notice Sets the parameters of period proposals created from now on.
    function setParams(Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    /// @notice Sets the fewest ballots a poll needs to be decrypted (1 to `MAX_MIN_VOTERS`). A
    ///         rotation poll below it ends as `NoChange`, a proposal below it as defeated, and
    ///         neither is decrypted. Applies to polls closed from now on.
    function setMinVoters(uint32 minVoters_) external onlyOwner {
        if (minVoters_ == 0 || minVoters_ > MAX_MIN_VOTERS) revert InvalidParams();
        minVoters = minVoters_;
        emit MinVotersSet(minVoters_);
    }

    /// @notice Sets the curator registry whose weekly curations feed the curated phase, and
    ///         reads its weekly clock. Once.
    function setCuratorRegistry(ICuratorRegistry curators_) external onlyOwner {
        if (address(curators) != address(0)) revert CuratorRegistryAlreadySet();
        if (address(curators_) == address(0)) revert ZeroAddress();
        address clock = ICuratorClock(address(curators_)).governor();
        if (clock == address(0)) revert CuratorClockNotSet();
        uint256 zero = IEpochGovernor(clock).epochZeroStart();
        uint256 length = IEpochGovernor(clock).EPOCH_LENGTH();
        if (length == 0) revert CuratorClockNotSet();
        curators = curators_;
        ballotBuilder.setCurators(curators_, zero, length);
        emit CuratorRegistrySet(address(curators_), zero, length);
    }

    /// @inheritdoc IRotationGovernor
    function setShortlist(address token, IEpochGovernor.Pin[] calldata pins) external {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
        (bytes32[] memory orgs, bytes32[] memory causes) = ballotBuilder.validatePins(token, pins);
        _shortlists[token] = orgs;
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
        // The weekly launch rule: the focus must give the latest catalogue a ballot's worth.
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        uint256 size = _catalog.poolSize(_catalog.latestVersion(), categoryMask, regionMask);
        if (size < MIN_OPTIONS) revert PoolTooSmall(token, size);
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

    /// @notice Prepares the next rotation's round of `token` without draws: enough when the pins
    ///         fill the ballot or the pool is empty (as the weekly `openEpoch`). Permissionless.
    /// @return target The rotation the poll decides.
    function openRound(address token) external returns (uint64 target) {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        target = _schedules[token].indexAt(block.timestamp) + 1;
        _prepare(token, target, new IEpochGovernor.CuratedDraw[](0), new IEpochGovernor.Draw[](0));
    }

    /// @inheritdoc IRotationGovernor
    function prepareRound(address token, uint64 target, IEpochGovernor.Draw[] calldata draws)
        external
    {
        _prepare(token, target, new IEpochGovernor.CuratedDraw[](0), draws);
    }

    /// @inheritdoc IRotationGovernor
    function prepareCuratedRound(
        address token,
        uint64 target,
        IEpochGovernor.CuratedDraw[] calldata curated,
        IEpochGovernor.Draw[] calldata draws
    ) external {
        _prepare(token, target, curated, draws);
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

    /// @notice Closes the poll for `target` once voting ended. With fewer than `minVoters` ballots
    ///         the round ends as `NoChange` (nothing is decrypted); otherwise the scheme is asked
    ///         to reveal the winner only. Permissionless.
    function closeRound(address token, uint64 target) external {
        Round storage r = _rounds[token][target];
        RoundStatus st = r.status;
        if (st == RoundStatus.None) revert RoundNotOpened(token, target);
        if (st != RoundStatus.Open) revert RoundAlreadyClosed(token, target);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < r.voteEnd) revert VotingNotEnded();

        if (r.voters == 0 || r.voters < minVoters) {
            r.status = RoundStatus.NoChange;
            emit RoundClosed(token, target, false);
            emit RoundFinalized(token, target, RoundStatus.NoChange, bytes32(0), 0);
            return;
        }
        r.status = RoundStatus.Closed;
        r.scheme.requestOutcome(token, PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target), 1);
        emit RoundClosed(token, target, true);
    }

    /// @notice Applies the revealed winner of `target`. Permissionless.
    /// @dev The scheme reveals only the strict argmax (ties to the lowest index), or `NO_WINNER`
    ///      when no option received weight. The winner is materialized into the cause registry and
    ///      applies from the rotation after the current one: `target` when finalized on time,
    ///      later otherwise. A round older than the last applied one is recorded as `Stale`; a
    ///      winner blocked since the ballot was prepared as `InactiveWinner`.
    function finalizeRound(address token, uint64 target) external {
        Round storage r = _rounds[token][target];
        if (r.status != RoundStatus.Closed) revert RoundNotClosed(token, target);
        (bool isFinal, uint8 index) = r.scheme
            .outcomeOf(
                address(this), token, PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target)
            );
        if (!isFinal) revert TallyNotFinal();
        bytes32[] storage options = r.options;
        bool none = index == NO_WINNER;
        if (!none && index >= options.length) revert InvalidTally();
        bytes32 winnerOrg = none ? bytes32(0) : options[index];
        bytes32 winner = none ? bytes32(0) : CatalogBallotLib.causeIdOf(winnerOrg);

        CauseState storage cs = _causes[token];
        RoundStatus status;
        uint64 effectiveFrom;
        if (none) {
            status = RoundStatus.NoChange;
        } else if (target <= cs.lastAppliedTarget) {
            status = RoundStatus.Stale;
        } else if (causeRegistry.isBlocked(winner)) {
            status = RoundStatus.InactiveWinner;
        } else {
            // A catalogue winner is written to the registry so the vault can pay it.
            causeRegistry.materialize(winnerOrg);
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
    /// @dev Requires a nonzero hold weight that also meets the proposal threshold, no other
    ///      active proposal for the token and this period, and elapsed cooldowns (this period's,
    ///      and the token-wide one after an execution). Not possible in rotation 0 (the snapshot
    ///      predates the token, so there is no circulating supply).
    /// @return id The proposal id.
    function proposePeriod(address token, RotationPeriod newPeriod) external returns (uint64 id) {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        uint64 pending = activeProposalOf[token][newPeriod];
        if (pending != 0) revert ProposalPending(pending);
        Params memory p = _params;
        _checkCooldown(lastProposalEnd[token][newPeriod], p.cooldown);
        _checkCooldown(lastExecutedEnd[token], p.cooldown);

        RotationScheduleLib.Schedule memory s = _schedules[token];
        uint64 c = s.indexAt(block.timestamp);
        if (s.periodOf(c + 1) == newPeriod) revert SamePeriod();
        uint256 snapshot = s.startOf(c) - 1;
        uint256 holdFrom = _holdFrom(snapshot, s.periodOf(c));

        uint256 circulating = _circulating(token, snapshot);
        if (circulating == 0) revert NoCirculatingSupply();
        uint64 weight = _holdWeight(token, holdFrom, snapshot, msg.sender);
        uint256 required = (circulating * p.proposalThresholdBps) / BPS;
        if (weight == 0 || weight < required) revert BelowProposalThreshold(weight, required);
        uint64 quorumWeight =
            SafeCast.toUint64(FullMath.mulDivRoundingUp(circulating, p.quorumBps, BPS));

        id = ++proposalCount;
        uint40 end = SafeCast.toUint40(block.timestamp + p.votingPeriod);
        IOutcomeVotingScheme sch = _scheme;
        PeriodProposal storage pp = _proposals[id];
        pp.token = token;
        pp.newPeriod = newPeriod;
        pp.snapshot = SafeCast.toUint40(snapshot);
        pp.end = end;
        pp.proposer = msg.sender;
        pp.executionDeadline = end + p.executionWindow;
        pp.scheme = sch;
        pp.quorumWeight = quorumWeight;
        pp.holdFrom = SafeCast.toUint40(holdFrom);
        pp.executionsAtProposal = executions[token];
        activeProposalOf[token][newPeriod] = id;

        sch.open(token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id), 2);
        emit PeriodProposed(token, id, msg.sender, newPeriod, pp.snapshot, end, quorumWeight);
    }

    /// @notice Closes an ended proposal: with fewer than `minVoters` ballots it is defeated
    ///         (nothing is decrypted), otherwise the scheme is asked to reveal the outcome only
    ///         (FOR wins with `for > against` and `for >= quorumWeight`). Permissionless.
    function closePeriodProposal(uint64 id) external {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (st != ProposalState.Ended) revert NotClosable(id, st);
        if (p.voters == 0 || p.voters < minVoters) {
            p.flags |= FLAG_CLOSED | FLAG_DEFEATED;
            _endProposal(p, false);
            emit PeriodProposalClosed(id, false);
            emit PeriodProposalTallied(id, false);
            return;
        }
        p.flags |= FLAG_CLOSED;
        p.scheme
            .requestOutcome(
                p.token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id), p.quorumWeight
            );
        emit PeriodProposalClosed(id, true);
    }

    /// @notice Applies the revealed outcome of a closed proposal. Permissionless.
    /// @dev Passes when the revealed winner is FOR (`for > against && for >= quorumWeight`). A
    ///      passed proposal executed within its window schedules the new period from the next
    ///      boundary, unless another proposal of the token was executed after this one was created
    ///      (then it is superseded and expires). Without a final outcome it reverts
    ///      `TallyNotFinal` until the window ends, then expires.
    /// @return executed Whether the period change was scheduled.
    function executePeriodProposal(uint64 id) external returns (bool executed) {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (st != ProposalState.Closed) revert NotExecutable(id, st);
        address token = p.token;

        (bool isFinal, uint8 index) = p.scheme
            .outcomeOf(address(this), token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id));
        // forge-lint: disable-next-line(block-timestamp)
        bool late = block.timestamp > p.executionDeadline;
        if (!isFinal) {
            if (!late) revert TallyNotFinal();
            p.flags |= FLAG_EXPIRED;
            _endProposal(p, false);
            emit PeriodProposalExpired(id);
            return false;
        }
        if (index != NO_WINNER && index > OPTION_FOR) revert InvalidTally();
        bool passed = index == OPTION_FOR;

        if (!passed) {
            p.flags |= FLAG_DEFEATED;
        } else if (late || executions[token] != p.executionsAtProposal) {
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
        _endProposal(p, executed);
        emit PeriodProposalTallied(id, passed);
    }

    /// @notice Cancels an active proposal that has no ballot yet. Proposer only. Starts no
    ///         cooldown.
    function cancelPeriodProposal(uint64 id) external {
        PeriodProposal storage p = _proposals[id];
        ProposalState st = _state(p);
        if (st == ProposalState.None) revert UnknownProposal(id);
        if (msg.sender != p.proposer) revert NotProposer(msg.sender);
        if (st != ProposalState.Active) revert NotCancelable(id, st);
        if (p.voters != 0) revert ProposalHasBallots(id);
        p.flags |= FLAG_CANCELED;
        delete activeProposalOf[p.token][p.newPeriod];
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
        return (
            r.status,
            r.snapshot,
            r.voteEnd,
            r.voters,
            r.winner,
            r.effectiveFrom,
            CatalogBallotLib.causeIds(r.options)
        );
    }

    /// @notice Catalogue org ids of round `target`'s options, in ballot order.
    function roundOptionOrgIds(address token, uint64 target)
        external
        view
        returns (bytes32[] memory)
    {
        return _rounds[token][target].options;
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

    /// @notice Whole-token hold weight of `account`: its lowest vote checkpoint over
    ///         `[holdFrom, snapshot]` (zero while the snapshot is not past).
    function holdWeightAt(address token, uint256 holdFrom, uint256 snapshot, address account)
        external
        view
        returns (uint64)
    {
        return _holdWeight(token, holdFrom, snapshot, account);
    }

    /// @notice Hold window `[holdFrom, snapshot]` of the rotation poll for `target` (zero if the
    ///         round was never opened).
    function roundHoldWindow(address token, uint64 target)
        external
        view
        returns (uint40 holdFrom, uint40 snapshot)
    {
        Round storage r = _rounds[token][target];
        return (r.holdFrom, r.snapshot);
    }

    /// @inheritdoc IRotationGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        return CatalogBallotLib.causeIds(_shortlists[token]);
    }

    /// @inheritdoc IRotationGovernor
    /// @dev Pins apply to every round prepared from now on, so `target` does not change it.
    function shortlistFor(address token, uint256) external view returns (bytes32[] memory) {
        return CatalogBallotLib.causeIds(_shortlists[token]);
    }

    /// @notice Pinned catalogue org ids of `token`.
    function shortlistOrgIdsOf(address token) external view returns (bytes32[] memory) {
        return _shortlists[token];
    }

    /// @inheritdoc IRotationGovernor
    function poolOf(address token, uint256 target)
        external
        view
        returns (uint32 version, uint256 poolSize)
    {
        if (target == 0 || target > type(uint64).max) return (0, 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        Round storage r = _rounds[token][uint64(target)];
        if (r.status != RoundStatus.None) return (r.catalogVersion, r.poolSize);
        (bool ok, uint40 voteStart) = _voteStart(token, target);
        if (!ok) return (0, 0);
        (version,,) = ballotBuilder.versionOf(voteStart);
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        poolSize = _catalog.poolSize(version, categoryMask, regionMask);
    }

    /// @inheritdoc IRotationGovernor
    function drawIndex(address token, uint256 target, uint32 version, uint256 k, uint256 poolSize)
        external
        pure
        returns (uint256)
    {
        return CatalogBallotLib.drawIndex(token, target, version, k, poolSize);
    }

    /// @inheritdoc IRotationGovernor
    function ballotSize() external view returns (uint256) {
        return _maxOptions(_scheme);
    }

    /// @inheritdoc IRotationGovernor
    function curationEpochOf(address token, uint256 target)
        external
        view
        returns (bool ok, uint256 epoch)
    {
        uint40 voteStart;
        (ok, voteStart) = _voteStart(token, target);
        if (ok) (, ok, epoch) = ballotBuilder.versionOf(voteStart);
    }

    /// @notice The cause catalogue.
    function catalog() external view returns (address) {
        return address(_catalog);
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

    /// @dev Fixes round `target`'s ballot (pins, curated picks, rotation draws; see
    ///      `CatalogBallotLib`) and opens its poll when it has at least `MIN_OPTIONS` options.
    ///
    ///      Curated draws, when given, always apply; without them the curated phase applies only
    ///      during the round's curation grace (`CatalogBallotBuilder.curationGraceEnd`), so picks
    ///      committed but never published hold a round for that grace, not for the week.
    function _prepare(
        address token,
        uint64 target,
        IEpochGovernor.CuratedDraw[] memory curated,
        IEpochGovernor.Draw[] memory draws
    ) private {
        (Round storage r, uint40 voteStart) = _startRound(token, target);
        IOutcomeVotingScheme sch = _scheme;
        bytes32[] memory options = _build(r, token, target, voteStart, sch, curated, draws);
        if (options.length < MIN_OPTIONS) {
            r.status = RoundStatus.NoBallot;
            emit RoundFinalized(token, target, RoundStatus.NoBallot, bytes32(0), 0);
            return;
        }
        r.status = RoundStatus.Open;
        r.scheme = sch;
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
        // Bounded by MAX_OPTIONS, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        sch.open(token, scope, uint8(options.length));
        emit RoundOpened(token, target, scope, options, r.snapshot, r.voteEnd, address(sch));
    }

    /// @dev Checks that round `target` is the next rotation's, unprepared and still in its vote
    ///      window, and stores its snapshot, hold window and vote end. Returns the round and its
    ///      vote start.
    function _startRound(address token, uint64 target)
        private
        returns (Round storage r, uint40 voteStart)
    {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (target != s.indexAt(block.timestamp) + 1) revert RoundNotCurrent(target);
        r = _rounds[token][target];
        if (r.status != RoundStatus.None) revert RoundAlreadyOpened(token, target);
        uint40 snapshot;
        uint40 voteEnd;
        (snapshot, voteStart, voteEnd) = _window(s, target);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= voteEnd) revert VotingClosed();
        r.snapshot = snapshot;
        // `holdFrom <= snapshot`, which fits in 40 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        r.holdFrom = uint40(_holdFrom(snapshot, s.periodOf(target - 1)));
        r.voteEnd = voteEnd;
    }

    /// @dev Builds and stores round `target`'s ballot (`CatalogBallotBuilder.build`: the
    ///      catalogue version, curation epoch and curation grace of the round). Returns the
    ///      options' cause ids.
    function _build(
        Round storage r,
        address token,
        uint64 target,
        uint40 voteStart,
        IOutcomeVotingScheme sch,
        IEpochGovernor.CuratedDraw[] memory curated,
        IEpochGovernor.Draw[] memory draws
    ) private returns (bytes32[] memory) {
        CatalogBallotBuilder.Request memory q;
        q.token = token;
        q.round = target;
        q.size = _maxOptions(sch);
        q.pins = _shortlists[token];
        q.voteStart = voteStart;
        q.voteEnd = r.voteEnd;
        CatalogBallotBuilder.Built memory out = ballotBuilder.build(q, curated, draws);
        if (out.curatedDrawn != 0) {
            // Both are bounded by the ballot size (at most MAX_OPTIONS).
            // forge-lint: disable-next-line(unsafe-typecast)
            emit CuratedPicksUsed(
                token,
                target,
                out.curationEpoch,
                uint8(out.curatedDrawn),
                uint8(out.curatedIncluded)
            );
        }
        r.catalogVersion = out.version;
        // A pool is at most 1024 buckets of uint32 entries.
        // forge-lint: disable-next-line(unsafe-typecast)
        r.poolSize = uint64(out.pool);
        r.options = out.orgs;
        emit BallotPrepared(token, target, out.version, out.pool, out.pinned, out.options);
        return out.options;
    }

    /// @dev Vote start of round `target` from the current schedule (false when it has none).
    function _voteStart(address token, uint256 target) private view returns (bool, uint40) {
        if (!_causes[token].registered || target == 0 || target > type(uint64).max) {
            return (false, 0);
        }
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (target - 1 < s.anchorIndex) return (false, 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        (, uint40 voteStart,) = _window(s, uint64(target));
        return (true, voteStart);
    }

    function _authorizeRotation(address token, uint64 target, address voter, bytes32 ballotRef)
        private
        returns (uint64 weight)
    {
        if (!_causes[token].registered) revert TokenNotRegistered(token);
        RotationScheduleLib.Schedule memory s = _schedules[token];
        if (target != s.indexAt(block.timestamp) + 1) revert RoundNotCurrent(target);

        // Ballots are accepted only once the round was prepared by an earlier transaction: an
        // option index is only meaningful against the frozen options.
        Round storage r = _rounds[token][target];
        RoundStatus st = r.status;
        bool opened = st != RoundStatus.None && st != RoundStatus.NoBallot;
        address expected = opened ? address(r.scheme) : address(_scheme);
        if (msg.sender != expected) revert NotScheme(msg.sender);
        if (!opened) {
            if (st == RoundStatus.NoBallot) revert NoShortlist(token);
            revert RoundNotOpened(token, target);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (st != RoundStatus.Open || block.timestamp >= r.voteEnd) revert VotingClosed();

        if (r.voted[voter]) revert AlreadyVoted(voter);
        weight = _holdWeight(token, r.holdFrom, r.snapshot, voter);
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
        weight = _holdWeight(token, p.holdFrom, p.snapshot, voter);
        if (weight == 0) revert InvalidVote();
        _periodVoted[id][voter] = true;
        unchecked {
            ++p.voters;
        }
        emit PeriodVoteCast(token, id, ballotRef);
    }

    /// @dev Frees the proposal's slot and starts its cooldown: token wide after an execution,
    ///      for its period otherwise (defeat or expiry).
    function _endProposal(PeriodProposal storage p, bool executed) private {
        address token = p.token;
        delete activeProposalOf[token][p.newPeriod];
        if (executed) {
            lastExecutedEnd[token] = p.end;
            ++executions[token];
        } else {
            lastProposalEnd[token][p.newPeriod] = p.end;
        }
    }

    function _checkCooldown(uint40 since, uint32 cooldown) private view {
        if (since == 0) return;
        uint256 until = uint256(since) + cooldown;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < until) revert CooldownActive(until);
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

    /// @dev Start of the hold window ending at `snapshot` for a rotation of `p`.
    function _holdFrom(uint256 snapshot, RotationPeriod p) private pure returns (uint256) {
        uint256 lookback = RotationScheduleLib.length(p);
        if (lookback < MIN_HOLD_LOOKBACK) lookback = MIN_HOLD_LOOKBACK;
        return snapshot > lookback ? snapshot - lookback : 0;
    }

    /// @dev Whole-token lowest vote checkpoint of `account` over `[holdFrom, snapshot]`, capped
    ///      to 64 bits; zero while the snapshot is not yet in the past. Reads the value in effect
    ///      at `holdFrom` and at `snapshot`, then the checkpoints in between from the newest down,
    ///      at most `MAX_HOLD_SCAN` of them.
    function _holdWeight(address token, uint256 holdFrom, uint256 snapshot, address account)
        private
        view
        returns (uint64)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) return 0;
        uint256 low = IVotes(token).getPastVotes(account, snapshot);
        if (low == 0) return 0;
        uint256 atStart = IVotes(token).getPastVotes(account, holdFrom);
        if (atStart < low) low = atStart;
        if (low == 0) return 0;

        ICheckpointVotes cv = ICheckpointVotes(token);
        // Index one past the last checkpoint with `key <= snapshot`.
        uint256 lo;
        uint256 hi = cv.numCheckpoints(account);
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (uint48 key,) = cv.checkpoints(account, uint32(mid));
            if (key > snapshot) hi = mid;
            else lo = mid + 1;
        }
        for (uint256 scanned; lo != 0 && scanned < MAX_HOLD_SCAN; ++scanned) {
            --lo;
            (uint48 key, uint208 value) = cv.checkpoints(account, uint32(lo));
            if (key <= holdFrom) break;
            if (value < low) {
                low = value;
                if (low == 0) return 0;
            }
        }
        uint256 whole = low / 1e18;
        // Capped just below, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
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
