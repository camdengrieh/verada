// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICauseCatalog} from "./interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {ICuratorRegistry} from "./interfaces/ICuratorRegistry.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {IBallotGovernor, IVotingScheme} from "./interfaces/IVotingScheme.sol";
import {CatalogBallotLib} from "./libraries/CatalogBallotLib.sol";
import {HoldWeightLib} from "./libraries/HoldWeightLib.sol";

/// @title EpochGovernor
/// @notice Epochs (weekly by default) in which holders pick the cause that receives a token's
///         cause pool.
/// @dev The governor owns eligibility, weights and ballot composition; the pluggable
///      `IVotingScheme` owns the ballots and the tally. An epoch is a poll keyed
///      `(this, token, epoch)` on the scheme it was opened with, so swapping the scheme only
///      affects epochs opened afterwards. Weights are the token's lowest vote checkpoint over
///      the hold window `[holdFromFor, snapshotFor]` in whole tokens (`HoldWeightLib`). The
///      snapshot is `snapshotOf(epoch)`, except in the epoch a token launches in, which predates
///      the token and uses its launch snapshot instead. The window is the whole previous epoch
///      (`holdWindow`, one epoch by default), so no buy-before, sell-after around the public
///      snapshot.
///      An epoch has two phases: a trading phase, then a voting phase, the last `votingWindow`
///      seconds, in which ballots are accepted (by default the voting phase is the whole epoch).
///      The snapshot is the second before the epoch starts, so weights are fixed before the
///      trading phase and trading in it cannot change them; with a 30 minute trading phase and a
///      15 minute voting phase the hold window (set to the trading phase, 30 minutes) is the last
///      30 minutes of the previous epoch: its voting phase and the end of its trading phase.
///      Whoever buys in an epoch's trading phase has no weight in that epoch and gains weight in
///      the next only by still holding it throughout the next snapshot's hold window.
///      Epoch length, voting window and hold window are owner-set and apply from the next epoch
///      (a schedule of segments, so `currentEpoch` and `epochStart` never re-index a started
///      epoch); only before the first token registers does a change re-anchor epoch zero.
///      Ballots come from the token's cause focus over `CauseCatalog`: the controller's pins plus
///      deterministic rotation draws (see `IEpochGovernor`). The catalogue version is the one in
///      effect at the epoch's start; pins and the ballot size are read when the ballot is
///      prepared, and a change made after that applies from the next epoch, so nobody can reshape
///      a prepared epoch's ballot. Ballots are accepted only once the epoch is opened, so a ballot's
///      option index always refers to the list frozen by an earlier transaction. Catalogue orgs
///      reach `CauseRegistry` storage only when one wins.
///      An epoch whose tally never arrives (scheme outage, governor delisted) finalizes to the
///      default cause once `tallyGrace` has passed, so its cause pool cannot be stranded.
contract EpochGovernor is IEpochGovernor, IBallotGovernor, Ownable2Step {
    using CatalogBallotLib for CatalogBallotLib.Ballot;

    /// @dev Epoch, voting window and hold window of epoch zero (the schedule's defaults).
    uint256 internal constant DEFAULT_EPOCH_LENGTH = 7 days;

    /// @inheritdoc IEpochGovernor
    uint256 public constant MIN_DURATION = 5 minutes;

    /// @inheritdoc IEpochGovernor
    uint256 public constant MAX_DURATION = 30 days;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MAX_OPTIONS = 32;

    /// @inheritdoc IEpochGovernor
    uint8 public constant MIN_OPTIONS = 2;

    /// @inheritdoc IEpochGovernor
    uint8 public constant PINNED_MAX = CatalogBallotLib.PINNED_MAX;

    /// @inheritdoc IEpochGovernor
    uint256 public constant DRAW_FACTOR = CatalogBallotLib.DRAW_FACTOR;

    /// @inheritdoc IEpochGovernor
    uint256 public tallyGrace = 14 days;

    /// @inheritdoc IEpochGovernor
    uint256 public launchSnapshotDelay = 1 days;

    /// @inheritdoc IEpochGovernor
    uint256 public curationGrace = 6 hours;

    /// @inheritdoc IEpochGovernor
    uint256 public immutable epochZeroStart;

    /// @notice Cause registry: blocked causes are skipped, winners are materialized into it.
    ICauseRegistry public immutable registry;

    ICauseCatalog private immutable _catalog;

    /// @notice Profile registry naming the controller allowed to pin causes, and each token's focus.
    ITokenProfileRegistry public immutable profileRegistry;

    /// @notice Factory allowed to register tokens (set once by the owner).
    address public factory;

    /// @inheritdoc IEpochGovernor
    bytes32 public defaultCause;

    IVotingScheme private _scheme;

    /// @inheritdoc IEpochGovernor
    /// @dev Packed with `_scheme`, which `_prepare` reads as well.
    uint8 public ballotSizeCap;

    /// @notice Curator agents' weekly picks (unset: no curated phase).
    ICuratorRegistry public curators;

    /// @dev Pinned catalogue org ids in effect (`current`) and an optional replacement (`next`)
    ///      taking effect from epoch `nextFrom` (zero: none scheduled). Views and events report
    ///      cause ids (`keccak256(orgId)`). `sizeChoice` is the token's ballot size
    ///      (`ballotSizeChoiceOf`), kept in the slot `_prepare` reads for the pins.
    struct Schedule {
        bytes32[] current;
        bytes32[] next;
        uint64 nextFrom;
        uint8 sizeChoice;
    }

    /// @dev Outcome of reading an epoch's tally from its scheme.
    enum TallyStatus {
        Valid,
        NotFinal,
        Invalid
    }

    struct EpochState {
        bool prepared;
        bool opened;
        bool closed;
        bool finalized;
        bool closeFailed;
        IVotingScheme scheme;
        uint32 catalogVersion;
        /// @dev Number of options (at most MAX_OPTIONS), packed with the flags above.
        uint8 optionCount;
        /// @dev Ballot size the epoch was prepared with (`ballotSizeFor`), in the same slot.
        uint8 ballotSize;
        bytes32 winner;
        uint256 voters;
        uint256 poolSize;
        /// @dev `keccak256(abi.encodePacked(orgIds))` of the options' catalogue org ids, in ballot
        ///      order. The ids themselves are only in `BallotPrepared`; `finalizeEpoch` takes them
        ///      back as calldata.
        bytes32 ballotHash;
        mapping(address voter => bool) voted;
    }

    /// @dev Epoch schedule in force from epoch `startEpoch`, which starts at `startTime`: epochs
    ///      last `length`, accept ballots in their last `votingWindow` and weigh over `holdWindow`.
    ///      Sorted by `startEpoch` and `startTime`. The last may be pending (its start in the
    ///      future); a change made while it is pending replaces it.
    struct Segment {
        uint64 startEpoch;
        uint64 startTime;
        uint32 length;
        uint32 votingWindow;
        uint32 holdWindow;
    }

    Segment[] private _segments;

    /// @dev Whether any token has ever registered. Until then no epoch can hold state.
    bool private _anyToken;

    /// @dev Start of the hold window of a token's launch epoch, fixed at registration so that a
    ///      later change of `launchSnapshotDelay` cannot move the weights of a running vote.
    mapping(address token => uint256) private _launchFromOf;

    mapping(address token => bool) public isRegistered;

    /// @inheritdoc IEpochGovernor
    mapping(address token => uint256) public launchSnapshotOf;

    mapping(address token => Schedule) private _shortlists;
    mapping(address token => mapping(uint256 epoch => EpochState)) private _epochs;
    mapping(address token => mapping(uint256 epoch => mapping(bytes32 causeId => uint256))) private
        _tally;
    /// @dev Hold-window scans run ahead of a ballot (`advanceHoldScan`).
    mapping(bytes32 window => HoldWeightLib.Scan) private _holdScans;

    /// @param initialOwner Admin allowed to set the factory once, swap the scheme and set the
    ///        fallback cause.
    /// @param registry_ Cause registry (this governor must be one of its materializers).
    /// @param catalog_ Cause catalogue.
    /// @param scheme_ Initial voting scheme.
    /// @param profileRegistry_ Token profile registry (pin authority and focus).
    constructor(
        address initialOwner,
        ICauseRegistry registry_,
        ICauseCatalog catalog_,
        IVotingScheme scheme_,
        ITokenProfileRegistry profileRegistry_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || address(catalog_) == address(0)
                || address(scheme_) == address(0) || address(profileRegistry_) == address(0)
        ) revert ZeroAddress();
        registry = registry_;
        _catalog = catalog_;
        _scheme = scheme_;
        profileRegistry = profileRegistry_;
        ballotSizeCap = MAX_OPTIONS;
        emit BallotSizeCapSet(MAX_OPTIONS);
        // Align epoch 0 to the Thursday 00:00 UTC at or before deployment (unix time 0 was a
        // Thursday), so the first epoch may be shorter than a full week.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 zero = (block.timestamp / DEFAULT_EPOCH_LENGTH) * DEFAULT_EPOCH_LENGTH;
        epochZeroStart = zero;
        // Defaults: weekly epochs, voting open the whole epoch, hold window of one epoch.
        _segments.push(
            Segment({
                startEpoch: 0,
                startTime: SafeCast.toUint64(zero),
                length: uint32(DEFAULT_EPOCH_LENGTH),
                votingWindow: uint32(DEFAULT_EPOCH_LENGTH),
                holdWindow: uint32(DEFAULT_EPOCH_LENGTH)
            })
        );
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the factory. Can only be done once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Replaces the voting scheme for epochs opened from now on. Epochs already opened
    ///         keep the scheme they were opened with.
    function setScheme(IVotingScheme scheme_) external onlyOwner {
        if (address(scheme_) == address(0)) revert ZeroAddress();
        _scheme = scheme_;
        emit SchemeUpdated(address(scheme_));
    }

    /// @notice Sets the fallback cause paid when an epoch ends with no ballots, so its funds are
    ///         never stranded. Zero clears the fallback; otherwise the cause must be active.
    function setDefaultCause(bytes32 causeId) external onlyOwner {
        if (causeId != bytes32(0) && !registry.isActive(causeId)) revert InactiveCause(causeId);
        defaultCause = causeId;
        emit DefaultCauseSet(causeId);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev Applies from the next epoch: the schedule gains a segment starting at the next
    ///      epoch's start (a change already pending for it is replaced), so the current and every
    ///      earlier epoch keep their start, end, voting window and hold window. Before any token
    ///      has registered no epoch holds state, so the change re-anchors epoch zero instead and
    ///      the first cycle can already be short. Callers that cached the epoch length (the
    ///      rotation ballot builder) do not follow later changes.
    function setEpochSchedule(uint256 length, uint256 votingWindow_, uint256 holdWindow_)
        external
        onlyOwner
    {
        _checkDuration(length);
        _checkDuration(holdWindow_);
        if (votingWindow_ < MIN_DURATION || votingWindow_ > length) {
            revert DurationOutOfRange(votingWindow_, MIN_DURATION, length);
        }
        uint256 startEpoch;
        uint256 startTime = epochZeroStart;
        if (_anyToken) {
            startEpoch = currentEpoch() + 1;
            startTime = epochStart(startEpoch);
        }
        Segment memory seg = Segment({
            startEpoch: SafeCast.toUint64(startEpoch),
            startTime: SafeCast.toUint64(startTime),
            length: SafeCast.toUint32(length),
            votingWindow: SafeCast.toUint32(votingWindow_),
            holdWindow: SafeCast.toUint32(holdWindow_)
        });
        uint256 last = _segments.length - 1;
        // Replaces epoch zero before the first token, or a segment that has not started yet.
        // forge-lint: disable-next-line(block-timestamp)
        if (!_anyToken || _segments[last].startTime > block.timestamp) _segments[last] = seg;
        else _segments.push(seg);
        emit EpochScheduleSet(startEpoch, startTime, length, votingWindow_, holdWindow_);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev Applies at once: it only decides when an epoch that still has no valid final tally
    ///      may fall back to the default cause, never reopens a finalized epoch, and a longer
    ///      grace only delays that fallback.
    function setTallyGrace(uint256 grace) external onlyOwner {
        _checkDuration(grace);
        tallyGrace = grace;
        emit TallyGraceSet(grace);
    }

    /// @inheritdoc IEpochGovernor
    function setLaunchSnapshotDelay(uint256 delay) external onlyOwner {
        _checkDuration(delay);
        launchSnapshotDelay = delay;
        emit LaunchSnapshotDelaySet(delay);
    }

    /// @inheritdoc IEpochGovernor
    function setCurationGrace(uint256 grace) external onlyOwner {
        _checkDuration(grace);
        curationGrace = grace;
        emit CurationGraceSet(grace);
    }

    /// @inheritdoc IEpochGovernor
    function setBallotSizeCap(uint8 cap) external onlyOwner {
        if (cap < MIN_OPTIONS || cap > MAX_OPTIONS) revert BallotSizeOutOfRange(cap);
        ballotSizeCap = cap;
        emit BallotSizeCapSet(cap);
    }

    /// @inheritdoc IEpochGovernor
    function setShortlist(address token, Pin[] calldata pins) external {
        _checkController(token);
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        (bytes32[] memory orgs, bytes32[] memory causes) =
            CatalogBallotLib.validatePins(_catalog, registry, categoryMask, regionMask, pins);
        uint256 size = _sizeOf(token);
        if (orgs.length > size) revert ShortlistTooLong(orgs.length, size);
        // Until the current epoch's ballot is prepared the new pins may still apply to it.
        uint256 effectiveFrom =
            _schedule(_shortlists[token], orgs, !_epochs[token][currentEpoch()].prepared);
        emit ShortlistSet(token, causes);
        emit ShortlistScheduled(token, effectiveFrom, causes);
    }

    /// @inheritdoc IEpochGovernor
    function setBallotSize(address token, uint8 size) external {
        _checkController(token);
        if (size != 0 && (size < MIN_OPTIONS || size > MAX_OPTIONS)) {
            revert BallotSizeOutOfRange(size);
        }
        _shortlists[token].sizeChoice = size;
        // Like pins: the current epoch's ballot takes it unless it is already prepared.
        uint256 epoch = currentEpoch();
        if (_epochs[token][epoch].prepared) ++epoch;
        emit BallotSizeSet(token, size, epoch);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev A token registered in the epoch it was created in had no supply at that epoch's
    ///      snapshot, so nobody could vote in it. Such a token gets a launch snapshot inside the
    ///      epoch: `launchSnapshotDelay` after registration, or halfway to the epoch's end when
    ///      less than twice that remains, so holders who bought at launch can vote on the fees of
    ///      the launch epoch. Like every snapshot, it is fixed and public in advance.
    function registerToken(address token) external {
        if (msg.sender != factory) revert NotFactory();
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        uint256 size = _catalog.poolSize(_catalog.latestVersion(), categoryMask, regionMask);
        if (size < MIN_OPTIONS) revert PoolTooSmall(token, size);
        isRegistered[token] = true;
        if (!_anyToken) _anyToken = true;

        uint256 epoch = currentEpoch();
        if (launchSnapshotOf[token] != 0 || _hasSupplyAt(token, snapshotOf(epoch))) return;
        uint256 end = epochStart(epoch + 1);
        uint256 maxDelay = launchSnapshotDelay;
        uint256 delay = (end - block.timestamp) / 2;
        if (delay > maxDelay) delay = maxDelay;
        uint256 snapshot = block.timestamp + delay;
        launchSnapshotOf[token] = snapshot;
        // The hold window of the launch epochs starts the later half of the delay before it.
        delay = end - snapshot;
        if (delay > maxDelay) delay = maxDelay;
        _launchFromOf[token] = snapshot - delay / 2;
        emit LaunchSnapshotSet(token, epoch, snapshot);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @inheritdoc IEpochGovernor
    function prepareBallot(address token, uint256 epoch, Draw[] calldata draws) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, new CuratedDraw[](0), draws);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev Published curations can no longer be skipped, so this always reverts.
    function requestCurationSkip(address token, uint256 epoch) external pure {
        revert CurationSkipDisabled(token, epoch);
    }

    /// @inheritdoc IEpochGovernor
    function curationSkipAt(address, uint256) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IEpochGovernor
    function prepareCuratedBallot(
        address token,
        uint256 epoch,
        CuratedDraw[] calldata curated,
        Draw[] calldata draws
    ) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, curated, draws);
    }

    /// @inheritdoc IEpochGovernor
    function setCuratorRegistry(ICuratorRegistry curators_) external onlyOwner {
        if (address(curators) != address(0)) revert CuratorRegistryAlreadySet();
        if (address(curators_) == address(0)) revert ZeroAddress();
        curators = curators_;
        emit CuratorRegistrySet(address(curators_));
    }

    /// @inheritdoc IEpochGovernor
    function openEpoch(address token, uint256 epoch) external {
        _checkPreparable(token, epoch);
        _prepare(token, epoch, new CuratedDraw[](0), new Draw[](0));
    }

    /// @inheritdoc IBallotGovernor
    /// @dev Called by the scheme while the voter's `castBallot` transaction executes. The epoch
    ///      must already be opened: a ballot's encrypted option index is only meaningful against
    ///      the frozen ballot (`BallotPrepared`), and a ballot that prepared the epoch itself would be counted
    ///      against whatever list was in effect when it was mined (the controller can change the
    ///      pins of an unprepared epoch, and blocks shift the remaining options).
    function authorizeBallot(address token, uint256 scope, address voter, bytes32 ballotRef)
        external
        returns (uint64 weight)
    {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (scope != currentEpoch()) revert EpochNotCurrent(scope);

        EpochState storage s = _epochs[token][scope];
        IVotingScheme expected = s.opened ? s.scheme : _scheme;
        if (msg.sender != address(expected)) revert NotScheme(msg.sender);
        if (!s.opened) {
            // A prepared ballot with fewer than MIN_OPTIONS options never opens.
            if (s.prepared) revert NoShortlist(token);
            revert EpochNotOpened(token, scope);
        }
        // Ballots only in the epoch's voting phase (its last `votingWindow` seconds).
        uint256 opensAt = votingOpensAt(scope);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < opensAt) revert VotingNotOpen(scope, opensAt);

        if (s.voted[voter]) revert AlreadyVoted(voter);
        weight = _weightOf(token, scope, voter);
        if (weight == 0) revert InvalidVote();

        s.voted[voter] = true;
        unchecked {
            ++s.voters;
        }
        emit VoteCast(token, scope, ballotRef);
    }

    /// @inheritdoc IEpochGovernor
    function closeEpoch(address token, uint256 epoch) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);
        EpochState storage s = _epochs[token][epoch];
        if (!s.opened) revert EpochNotOpened(token, epoch);
        if (s.closed && !s.closeFailed) revert EpochAlreadyClosed(token, epoch);
        s.closed = true;
        uint256 gasBefore = gasleft();
        try s.scheme.requestTally(token, epoch) {
            s.closeFailed = false;
            emit EpochClosed(token, epoch);
        } catch {
            // A call starved of gas by the caller is not a scheme failure: revert so the epoch is
            // not marked failed on purpose. The callee gets at most 63/64 of the gas.
            if (gasleft() <= gasBefore / 64) revert InsufficientGas();
            s.closeFailed = true;
            emit EpochCloseFailed(token, epoch);
        }
    }

    /// @inheritdoc IEpochGovernor
    /// @dev With no ballots (or a tally that counted nothing) the owner-set `defaultCause` wins;
    ///      if none is set, or it is inactive, this reverts with `NoVotes` until one is. With
    ///      ballots but no valid final tally, this reverts until `tallyGrace` after the epoch's
    ///      end and then falls back to `defaultCause` as well. A catalogue winner is materialized
    ///      into the registry. The winner is stored even if the cause was blocked after the
    ///      ballot was prepared; the distributor resolves its payout from the registry, which
    ///      keeps deactivated records. `orgIds` is read only when a valid tally is applied.
    function finalizeEpoch(address token, uint256 epoch, bytes32[] calldata orgIds) external {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch >= currentEpoch()) revert EpochNotEnded(epoch);

        EpochState storage s = _epochs[token][epoch];
        if (s.finalized) revert EpochAlreadyFinalized(token, epoch);

        bytes32 winner;
        bytes32 winnerOrg;
        uint256 best;
        bool timedOut;
        if (s.opened && s.voters != 0) {
            uint256 n = s.optionCount;
            (TallyStatus status, uint64[] memory counts) = _finalCounts(s.scheme, token, epoch, n);
            if (status == TallyStatus.Valid) {
                if (orgIds.length != n || keccak256(abi.encodePacked(orgIds)) != s.ballotHash) {
                    revert BallotMismatch(token, epoch);
                }
                for (uint256 i; i < n; ++i) {
                    bytes32 causeId = CatalogBallotLib.causeIdOf(orgIds[i]);
                    _tally[token][epoch][causeId] = counts[i];
                    // Strictly greater, so ties go to the lowest index.
                    if (counts[i] > best) {
                        best = counts[i];
                        winner = causeId;
                        winnerOrg = orgIds[i];
                    }
                }
            } else {
                // forge-lint: disable-next-line(block-timestamp)
                if (block.timestamp < epochStart(epoch + 1) + tallyGrace) {
                    if (status == TallyStatus.Invalid) revert InvalidTally(token, epoch);
                    revert TallyNotFinal(token, epoch);
                }
                timedOut = true;
            }
        }
        if (best != 0) {
            // A catalogue winner is written to the registry so the distributor can pay it.
            registry.materialize(winnerOrg);
        } else {
            winner = defaultCause;
            if (winner == bytes32(0) || !registry.isActive(winner)) revert NoVotes(token, epoch);
            if (timedOut) emit TallyTimeoutFallbackApplied(token, epoch, winner);
            else emit NoVoteFallbackApplied(token, epoch, winner);
        }

        s.finalized = true;
        s.winner = winner;
        emit EpochFinalized(token, epoch, winner);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IEpochGovernor
    function currentEpoch() public view returns (uint256) {
        return _epochAt(block.timestamp);
    }

    /// @inheritdoc IEpochGovernor
    function epochStart(uint256 epoch) public view returns (uint256) {
        Segment memory s = _segmentOf(epoch);
        return s.startTime + (epoch - s.startEpoch) * s.length;
    }

    /// @inheritdoc IEpochGovernor
    function epochLength() external view returns (uint256) {
        return _segmentOf(currentEpoch()).length;
    }

    /// @inheritdoc IEpochGovernor
    function votingWindow() external view returns (uint256) {
        return _segmentOf(currentEpoch()).votingWindow;
    }

    /// @inheritdoc IEpochGovernor
    function holdWindow() external view returns (uint256) {
        return _segmentOf(currentEpoch()).holdWindow;
    }

    /// @inheritdoc IEpochGovernor
    function epochScheduleFor(uint256 epoch)
        external
        view
        returns (uint256 length, uint256 votingWindow_, uint256 holdWindow_)
    {
        Segment memory s = _segmentOf(epoch);
        return (s.length, s.votingWindow, s.holdWindow);
    }

    /// @inheritdoc IEpochGovernor
    function votingOpensAt(uint256 epoch) public view returns (uint256) {
        Segment memory s = _segmentOf(epoch);
        return s.startTime + (epoch + 1 - s.startEpoch) * s.length - s.votingWindow;
    }

    /// @inheritdoc IEpochGovernor
    function snapshotOf(uint256 epoch) public view returns (uint256) {
        return epochStart(epoch) - 1;
    }

    /// @inheritdoc IEpochGovernor
    function snapshotFor(address token, uint256 epoch) public view returns (uint256) {
        uint256 launch = launchSnapshotOf[token];
        if (launch != 0 && epoch == _epochAt(launch)) return launch;
        return snapshotOf(epoch);
    }

    /// @inheritdoc IEpochGovernor
    /// @dev A token with a launch snapshot starts the window of its launch epoch, and of the next
    ///      one (whose regular window predates the token), at the later half of its launch delay.
    function holdFromFor(address token, uint256 epoch) public view returns (uint256 holdFrom) {
        uint256 snapshot = snapshotFor(token, epoch);
        uint256 window = _segmentOf(epoch).holdWindow;
        holdFrom = snapshot > window ? snapshot - window : 0;
        uint256 launch = launchSnapshotOf[token];
        if (launch == 0 || launch > snapshot) return holdFrom;
        uint256 launchFrom = _launchFromOf[token];
        if (holdFrom < launchFrom) holdFrom = launchFrom;
    }

    /// @inheritdoc IEpochGovernor
    function scheme() external view returns (address) {
        return address(_scheme);
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOf(address token) external view returns (bytes32[] memory) {
        return CatalogBallotLib.causeIds(_listAt(_shortlists[token], currentEpoch()));
    }

    /// @inheritdoc IEpochGovernor
    function shortlistFor(address token, uint256 epoch) external view returns (bytes32[] memory) {
        return CatalogBallotLib.causeIds(_listAt(_shortlists[token], epoch));
    }

    /// @inheritdoc IEpochGovernor
    function pendingShortlistOf(address token)
        external
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        (bytes32[] memory orgs, uint256 from) = _pending(_shortlists[token]);
        return (CatalogBallotLib.causeIds(orgs), from);
    }

    /// @inheritdoc IEpochGovernor
    function shortlistOrgIdsFor(address token, uint256 epoch)
        external
        view
        returns (bytes32[] memory)
    {
        return _listAt(_shortlists[token], epoch);
    }

    /// @inheritdoc IEpochGovernor
    function poolOf(address token, uint256 epoch)
        external
        view
        returns (uint32 version, uint256 poolSize)
    {
        EpochState storage s = _epochs[token][epoch];
        if (s.prepared) return (s.catalogVersion, s.poolSize);
        version = _catalog.versionAt(epochStart(epoch));
        (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
        poolSize = _catalog.poolSize(version, categoryMask, regionMask);
    }

    /// @inheritdoc IEpochGovernor
    function drawIndex(address token, uint256 epoch, uint32 version, uint256 k, uint256 poolSize)
        public
        pure
        returns (uint256)
    {
        return CatalogBallotLib.drawIndex(token, epoch, version, k, poolSize);
    }

    /// @inheritdoc IEpochGovernor
    function ballotSize() external view returns (uint256) {
        return _size(0);
    }

    /// @inheritdoc IEpochGovernor
    function ballotSizeChoiceOf(address token) external view returns (uint8) {
        return _shortlists[token].sizeChoice;
    }

    /// @inheritdoc IEpochGovernor
    function ballotSizeFor(address token, uint256 epoch) external view returns (uint256) {
        EpochState storage s = _epochs[token][epoch];
        return s.prepared ? s.ballotSize : _sizeOf(token);
    }

    /// @inheritdoc IEpochGovernor
    function catalog() external view returns (address) {
        return address(_catalog);
    }

    /// @inheritdoc IEpochGovernor
    function isPrepared(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].prepared;
    }

    /// @inheritdoc IEpochGovernor
    function ballotCommitment(address token, uint256 epoch)
        external
        view
        returns (bytes32 commitment, uint8 optionCount)
    {
        EpochState storage s = _epochs[token][epoch];
        return (s.ballotHash, s.optionCount);
    }

    /// @inheritdoc IEpochGovernor
    function epochScheme(address token, uint256 epoch) external view returns (address) {
        return address(_epochs[token][epoch].scheme);
    }

    /// @inheritdoc IEpochGovernor
    function isOpened(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].opened;
    }

    /// @inheritdoc IEpochGovernor
    function isClosed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closed;
    }

    /// @inheritdoc IEpochGovernor
    function closeFailed(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].closeFailed;
    }

    /// @inheritdoc IEpochGovernor
    function isFinalized(address token, uint256 epoch) external view returns (bool) {
        return _epochs[token][epoch].finalized;
    }

    /// @inheritdoc IEpochGovernor
    function winningCause(address token, uint256 epoch) external view returns (bytes32) {
        return _epochs[token][epoch].winner;
    }

    /// @inheritdoc IEpochGovernor
    function tally(address token, uint256 epoch, bytes32 causeId) external view returns (uint256) {
        return _tally[token][epoch][causeId];
    }

    /// @inheritdoc IEpochGovernor
    function hasVoted(address token, uint256 epoch, address voter) external view returns (bool) {
        return _epochs[token][epoch].voted[voter];
    }

    /// @inheritdoc IEpochGovernor
    function voterCount(address token, uint256 epoch) external view returns (uint256) {
        return _epochs[token][epoch].voters;
    }

    /// @inheritdoc IEpochGovernor
    function weightOf(address token, uint256 epoch, address account)
        external
        view
        returns (uint64)
    {
        return _weightOf(token, epoch, account);
    }

    /// @inheritdoc IEpochGovernor
    function advanceHoldScan(address token, uint256 epoch, address account, uint256 maxReads)
        external
        returns (bool done)
    {
        return HoldWeightLib.advance(
            _holdScans,
            token,
            account,
            holdFromFor(token, epoch),
            snapshotFor(token, epoch),
            maxReads
        );
    }

    // ------------------------------------------------------------------ internals

    function _checkDuration(uint256 value) private pure {
        if (value < MIN_DURATION || value > MAX_DURATION) {
            revert DurationOutOfRange(value, MIN_DURATION, MAX_DURATION);
        }
    }

    /// @dev Epoch containing `timestamp`, counted from the last segment that has started by then.
    function _epochAt(uint256 timestamp) private view returns (uint256) {
        uint256 lo;
        uint256 hi = _segments.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_segments[mid].startTime > timestamp) hi = mid;
            else lo = mid + 1;
        }
        Segment memory s = _segments[lo - 1];
        return s.startEpoch + (timestamp - s.startTime) / s.length;
    }

    /// @dev Segment `epoch` belongs to (the last one starting at or before it).
    function _segmentOf(uint256 epoch) private view returns (Segment memory) {
        uint256 lo;
        uint256 hi = _segments.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_segments[mid].startEpoch > epoch) hi = mid;
            else lo = mid + 1;
        }
        return _segments[lo - 1];
    }

    /// @dev Pins and the ballot size are set by the token's profile controller.
    function _checkController(address token) private view {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (msg.sender != profileRegistry.controllerOf(token)) {
            revert NotController(token, msg.sender);
        }
    }

    /// @dev Ballot size an epoch of `token` prepared now gets.
    function _sizeOf(address token) private view returns (uint256) {
        return _size(_shortlists[token].sizeChoice);
    }

    /// @dev `choice` (zero: `ballotSizeCap`), at most `ballotSizeCap` and the scheme's
    ///      `MAX_OPTIONS`. `ballotSizeCap <= MAX_OPTIONS` always holds.
    function _size(uint256 choice) private view returns (uint256 size) {
        size = ballotSizeCap;
        if (choice != 0 && choice < size) size = choice;
        uint256 schemeMax = _scheme.MAX_OPTIONS();
        if (schemeMax < size) size = schemeMax;
    }

    function _checkPreparable(address token, uint256 epoch) private view {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (epoch != currentEpoch()) revert EpochNotCurrent(epoch);
        EpochState storage s = _epochs[token][epoch];
        if (s.opened) revert EpochAlreadyOpened(token, epoch);
        if (s.prepared) revert BallotAlreadyPrepared(token, epoch);
    }

    /// @dev Fixes the epoch's ballot (pins, then curated picks, then rotation draws; see
    ///      `CatalogBallotLib`) and opens its poll when it has at least `MIN_OPTIONS` options.
    ///      The curated phase always applies: usable curations of the epoch and its catalogue
    ///      version need their curated draws, whoever prepares the ballot and whenever. Without
    ///      usable curations it consumes nothing.
    function _prepare(
        address token,
        uint256 epoch,
        CuratedDraw[] memory curated,
        Draw[] memory draws
    ) private {
        EpochState storage s = _epochs[token][epoch];
        uint32 version = _catalog.versionAt(epochStart(epoch));
        CatalogBallotLib.Ballot memory b = CatalogBallotLib.create(_sizeOf(token));
        // Pins past the size (lowered after they were set) are dropped in order.
        uint8 pinned = b.addPins(_listAt(_shortlists[token], epoch), registry);

        uint256 pool;
        uint256 used;
        uint256 curatedUsed;
        if (version != 0) {
            (uint64 categoryMask, uint16 regionMask) = profileRegistry.focusOf(token);
            uint16[] memory buckets;
            uint32[] memory sizes;
            (buckets, sizes, pool) =
                CatalogBallotLib.focusPool(_catalog, version, categoryMask, regionMask);
            bytes32 root = _catalog.rootOf(version);
            if (address(curators) != address(0) && b.n < b.size && buckets.length != 0) {
                ICuratorRegistry.Curation[] memory cs =
                    curators.curationsFor(epoch, version, buckets);
                uint256 included;
                (curatedUsed, included) =
                    b.curate(root, registry, token, epoch, buckets, sizes, cs, curated);
                if (curatedUsed != 0) {
                    // Both are bounded by the ballot size (at most 32).
                    // forge-lint: disable-next-line(unsafe-typecast)
                    emit CuratedPicksUsed(token, epoch, uint8(curatedUsed), uint8(included));
                }
            }
            if (pool != 0 && b.n < b.size) {
                used = b.draw(root, registry, token, epoch, version, pool, buckets, sizes, draws);
            }
        }
        if (curated.length != curatedUsed) revert TooManyCuratedDraws(curated.length, curatedUsed);
        if (draws.length != used) revert TooManyDraws(draws.length, used);

        (bytes32[] memory options, bytes32[] memory orgs) = b.seal();
        uint256 n = options.length;
        s.prepared = true;
        s.catalogVersion = version;
        // Ballots are capped at MAX_OPTIONS, which fits a uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.optionCount = uint8(n);
        // The size is at most ballotSizeCap, a uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.ballotSize = uint8(b.size);
        s.poolSize = pool;
        s.ballotHash = keccak256(abi.encodePacked(orgs));
        emit BallotPrepared(token, epoch, version, pool, pinned, orgs);

        if (n >= MIN_OPTIONS) {
            s.opened = true;
            s.scheme = _scheme;
            // Ballots are capped at MAX_OPTIONS, which fits a uint8.
            // forge-lint: disable-next-line(unsafe-typecast)
            _scheme.open(token, epoch, uint8(n));
            emit EpochOpened(token, epoch, options);
        }
    }

    /// @dev Whole-token lowest vote checkpoint of `account` over the epoch's hold window; zero
    ///      while the snapshot is not yet in the past.
    function _weightOf(address token, uint256 epoch, address account)
        private
        view
        returns (uint64)
    {
        return HoldWeightLib.lowest(
            _holdScans, token, account, holdFromFor(token, epoch), snapshotFor(token, epoch)
        );
    }

    /// @dev Whether `token` reports a non-zero total supply at `timepoint`. A token that cannot
    ///      answer is treated as having one, so it keeps the regular epoch snapshot.
    function _hasSupplyAt(address token, uint256 timepoint) private view returns (bool) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IVotes.getPastTotalSupply, (timepoint)));
        if (!ok || ret.length < 32) return true;
        return abi.decode(ret, (uint256)) != 0;
    }

    /// @dev Final per-option counts of the epoch's poll. A reverting scheme reads as not final.
    function _finalCounts(IVotingScheme scheme_, address token, uint256 epoch, uint256 n)
        private
        view
        returns (TallyStatus status, uint64[] memory counts)
    {
        try scheme_.tallyOf(address(this), token, epoch) returns (bool isFinal, uint64[] memory c) {
            if (!isFinal) return (TallyStatus.NotFinal, c);
            if (c.length != n) return (TallyStatus.Invalid, c);
            return (TallyStatus.Valid, c);
        } catch {
            return (TallyStatus.NotFinal, counts);
        }
    }

    /// @dev List of `s` in effect for `epoch` (exact for epochs at or after the one in which the
    ///      schedule last changed, which covers the current and later epochs).
    function _listAt(Schedule storage s, uint256 epoch) private view returns (bytes32[] storage) {
        uint256 from = s.nextFrom;
        return from != 0 && epoch >= from ? s.next : s.current;
    }

    function _pending(Schedule storage s)
        private
        view
        returns (bytes32[] memory causes, uint256 effectiveFrom)
    {
        uint256 from = s.nextFrom;
        if (from == 0 || currentEpoch() >= from) return (causes, 0);
        return (s.next, from);
    }

    /// @dev Replaces the list of `s` from the next epoch, or from the current one when
    ///      `immediate`. Returns the epoch from which `causes` apply.
    function _schedule(Schedule storage s, bytes32[] memory causes, bool immediate)
        private
        returns (uint256 effectiveFrom)
    {
        uint256 current = currentEpoch();
        uint256 from = s.nextFrom;
        if (from != 0 && current >= from) s.current = s.next;
        if (immediate) {
            s.current = causes;
            delete s.next;
            delete s.nextFrom;
            return current;
        }
        s.next = causes;
        // Epoch numbers fit 64 bits for longer than the chain will exist.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.nextFrom = uint64(current + 1);
        return current + 1;
    }
}
