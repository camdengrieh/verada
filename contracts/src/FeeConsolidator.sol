// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "./interfaces/IQuoteRegistry.sol";
import {IVaradaHook} from "./interfaces/IVaradaHook.sol";
import {V3RouteLib} from "./libraries/V3RouteLib.sol";

interface IConsolidatorRegistry is IQuoteRegistry {
    function routeOf(address asset) external view returns (PoolKey[] memory);
    function settlementAsset() external view returns (address);
}

interface IHookOracle {
    function twapTick(address token, uint32 window)
        external
        view
        returns (bool ok, int24 twapTick, uint32 span);
}

interface IWETH {
    function withdraw(uint256 amount) external;
}

/// @title FeeConsolidator
/// @notice Converts raw pool fees (the launched token and its quote asset) into the settlement
///         asset (USDC) through Uniswap v4 and credits them to the FeeVault.
/// @dev Flow: a source (the hook, the LP locker) delivers raw fees and calls `consolidate`. The
///      amount is recorded as held. If the pool manager is locked, the consolidator unlocks it
///      and swaps along the route (token pool first for the token side, then the quote asset's
///      registry route) atomically; the USDC is forwarded to the vault in the same transaction.
///      If the route reverts for any reason (paused or non-compliant Ondo token, no liquidity,
///      guard violation) the raw amount stays held, `ConsolidationFailed` is emitted, and
///      `retry` can be called by anyone. If the pool manager is already unlocked (the hook runs
///      inside a swap) nothing can be swapped yet, so the amount is simply held for `retry`.
///
///      Price guards, applied to every hop:
///       1. spot must be within `maxDeviationTicks` of a reference: the hook's TWAP for the
///          token's own pool, an owner seeded moving reference for registry route pools;
///       2. execution must return at least `max(spot, reference) * (1 - maxSlippageBps - hopFee)`.
///          The minimum is measured against the reference too, so pushing spot inside the
///          deviation band cannot widen the slippage allowance (the band and the tolerance never
///          add up).
///      Claim conversions run inside a trader's swap (`convertClaims` with `inSwap`) use the
///      tighter `inSwapMaxDeviationTicks` / `inSwapMaxSlippageBps` instead.
///      A failed guard fails closed (the raw balance is held), never executes at a bad price.
///      References follow spot slowly (`_moveReference`), after each successful hop and through
///      the permissionless `syncReference`, so a market that moved stays convertible.
///
///      Moving reference of a route pool: the reference follows spot after every successful hop
///      or `syncReference` (a fraction of `REFERENCE_WINDOW` per elapsed time, capped per move)
///      but never leaves `anchor ± maxDriftTicks`. The anchor itself follows the reference at a
///      bounded rate, at most `maxDriftTicks` per `ANCHOR_PERIOD`, with the elapsed time counted
///      for one period at most. A sustained trend no faster than that rate is followed without
///      the owner, while quiet time cannot be banked: whatever the history, a burst of
///      manipulated moves over a time `T` moves the reference at most
///      `2 * maxDriftTicks + maxDriftTicks * T / ANCHOR_PERIOD` away from where the market was.
///      A faster move or a gap fails closed until the market returns, the anchor catches up, or
///      the owner re-anchors.
///
///      Epoch attribution: every held raw amount is tagged with the epoch in which it was earned
///      (the current epoch for hook fees, the epochs of the accrual interval for LP fees). A swap
///      spends the oldest tags first and splits its output over them in proportion, so the vault
///      credits each epoch with what it earned, whoever triggers the swap and whenever. Before an
///      epoch is settled the vault calls `flushThrough`, so fees still held for that epoch are
///      swapped into it first rather than left to roll over to a later epoch.
///      `convertClaims` (live-donation tokens) never holds anything: it converts the caller's
///      claims and pays the settlement asset out in the same call, so it leaves every holding,
///      epoch tag and owed total untouched and never deposits into the vault.
contract FeeConsolidator is IFeeConsolidator, IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    /// @notice Per-pool reference tick for pools outside the hook oracle.
    struct Reference {
        int24 tick;
        /// @dev Time up to which the elapsed time has been applied to `tick`.
        uint40 updatedAt;
        bool set;
        /// @dev Centre of the band the moving tick stays in (`anchor ± maxDriftTicks`). Set by
        ///      the owner, then moved toward `tick` at a bounded rate.
        int24 anchor;
        /// @dev Time up to which the elapsed time has been applied to `anchor`.
        uint40 anchoredAt;
    }

    /// @dev Held raw fees of one (token, currency), packed in one slot. Parts tagged with epochs
    ///      below `last` live in `_heldIn` and sum to `older`; the part tagged `last` is
    ///      `total - older` and is kept here, so a hold in the newest epoch (every hook fee) is a
    ///      single slot write. The epochs are kept when `total` returns to zero, so the slot stays
    ///      non-zero and the next hold is not charged a fresh slot. 104 bits hold about 2e31,
    ///      above the whole supply of a launched token (1e29) or of any registry quote asset.
    struct Holding {
        uint104 total;
        uint104 older;
        /// @dev Lowest epoch that may hold a part (exact when `older` is zero: then `last`).
        uint24 first;
        uint24 last;
    }

    uint256 public constant BPS = 10_000;
    /// @notice Hard ceiling for `maxSlippageBps`.
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 2000;
    /// @notice Highest pool fee a hop may charge.
    uint256 public constant MAX_HOP_FEE_BPS = 1000;
    /// @notice TWAP window used for the token's own pool.
    uint32 public constant TWAP_WINDOW = 30 minutes;
    /// @notice Time over which a reference moves fully to spot after a successful hop.
    uint256 public constant REFERENCE_WINDOW = 1 days;
    /// @notice Initial in-swap deviation bound, in ticks (about 3%).
    uint256 public constant DEFAULT_IN_SWAP_DEVIATION_TICKS = 300;
    /// @notice Initial in-swap slippage bound, in basis points.
    uint256 public constant DEFAULT_IN_SWAP_SLIPPAGE_BPS = 100;
    /// @notice The anchor moves toward the reference by at most `maxDriftTicks` per this
    ///         period, and at most one period of elapsed time counts, so quiet time cannot be
    ///         saved up and spent in a burst.
    uint256 public constant ANCHOR_PERIOD = 7 days;
    /// @notice Highest `maxDeviationTicks` (and so `maxDriftTicks`): the full usable tick range.
    uint256 public constant MAX_TICK_SPAN = uint256(int256(TickMath.MAX_TICK)) * 2;
    /// @notice Most epochs one accrual interval is spread over; anything older is attributed
    ///         to the oldest of them.
    uint256 public constant MAX_ACCRUAL_EPOCHS = 52;

    IPoolManager public immutable poolManager;
    IConsolidatorRegistry public immutable quoteRegistry;
    IFeeVault public immutable vault;
    /// @notice The governor whose epochs fees are attributed to (the vault's governor).
    IEpochGovernor public immutable governor;
    /// @inheritdoc IFeeConsolidator
    address public immutable settlementAsset;
    address public immutable weth;

    /// @inheritdoc IFeeConsolidator
    uint256 public maxSlippageBps;
    /// @notice Largest tolerated distance, in ticks (about one basis point each), between spot
    ///         and its reference.
    uint256 public maxDeviationTicks;
    /// @notice Half width of the band around the anchor that the reference stays in, and the
    ///         most the anchor moves per `ANCHOR_PERIOD`, in ticks. At most `maxDeviationTicks`.
    uint256 public maxDriftTicks;
    /// @notice Deviation bound for claim conversions inside a trader's swap (the effective bound
    ///         is the smaller of this and `maxDeviationTicks`).
    uint256 public inSwapMaxDeviationTicks;
    /// @notice Slippage bound for claim conversions inside a trader's swap (the effective bound
    ///         is the smaller of this and `maxSlippageBps`).
    uint256 public inSwapMaxSlippageBps;

    /// @notice The hook that registers pools.
    address public hook;
    mapping(address account => bool allowed) public isSource;

    mapping(address token => PoolKey) private _poolKeys;
    mapping(address token => address quote) public quoteOf;
    mapping(address token => mapping(address currency => Holding)) private _holdings;
    /// @dev Parts of a holding tagged below its `last` epoch (token => currency => epoch).
    mapping(address => mapping(address => mapping(uint256 => uint256))) private _heldIn;
    /// @dev Owed per currency across tokens, stored plus one once used so the slot never
    ///      returns to zero (see `totalHeld`).
    mapping(address currency => uint256) private _owedPlusOne;
    mapping(PoolId id => Reference) public references;

    event SourceSet(address indexed account, bool allowed);
    event HookSet(address indexed hook);
    event PoolRegistered(address indexed token, address indexed quote, PoolId indexed poolId);
    event MaxDeviationTicksUpdated(uint256 ticks);
    event MaxDriftTicksUpdated(uint256 ticks);
    event ReferenceSet(PoolId indexed poolId, int24 tick);
    event ReferenceSynced(PoolId indexed poolId, int24 spotTick, int24 tick);
    event InSwapBoundsUpdated(uint256 maxDeviationTicks, uint256 maxSlippageBps);
    event Rescued(address indexed currency, address indexed to, uint256 amount);

    error ZeroAddress();
    error SettlementMismatch();
    error HookAlreadySet();
    error UnknownToken(address token);
    error InvalidCurrency(address token, address currency);
    error PoolAlreadyRegistered(address token);
    error QuoteNotRoutable(address quote);
    error NoRoute(address currency);
    error PoolManagerBusy();
    error PoolNotInitialized(PoolId id);
    error PartialFill(uint256 spent, uint256 expected);
    error HopFeeTooHigh(uint256 feeBps);
    error OracleUnavailable(address token);
    error ReferenceNotSet(PoolId id);
    error PriceDeviation(int24 spotTick, int24 referenceTick);
    error UnbackedDeposit(address currency, uint256 balance, uint256 required);
    error NothingToRescue(address currency);
    error AmountExceedsHeld(uint256 amount, uint256 held);
    error InvalidDeviation(uint256 ticks);
    error InvalidDrift(uint256 ticks);
    error V3Unsupported();

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    constructor(
        address owner_,
        IPoolManager poolManager_,
        IConsolidatorRegistry quoteRegistry_,
        IFeeVault vault_,
        address weth_,
        uint256 maxSlippageBps_,
        uint256 maxDeviationTicks_
    ) Ownable(owner_) {
        if (
            address(poolManager_) == address(0) || address(quoteRegistry_) == address(0)
                || address(vault_) == address(0) || weth_ == address(0)
        ) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING_BPS) revert InvalidSlippage(maxSlippageBps_);
        if (maxDeviationTicks_ > MAX_TICK_SPAN) revert InvalidDeviation(maxDeviationTicks_);
        address settlement = vault_.settlementAsset();
        if (settlement == address(0) || quoteRegistry_.settlementAsset() != settlement) {
            revert SettlementMismatch();
        }
        IEpochGovernor governor_ = vault_.governor();
        if (address(governor_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        quoteRegistry = quoteRegistry_;
        vault = vault_;
        governor = governor_;
        weth = weth_;
        settlementAsset = settlement;
        maxSlippageBps = maxSlippageBps_;
        maxDeviationTicks = maxDeviationTicks_;
        // Default drift band: a fraction of the deviation guard, so the guard stays meaningful.
        maxDriftTicks = maxDeviationTicks_ / 2;
        inSwapMaxDeviationTicks = DEFAULT_IN_SWAP_DEVIATION_TICKS;
        inSwapMaxSlippageBps = DEFAULT_IN_SWAP_SLIPPAGE_BPS;
    }

    receive() external payable {
        // Only the unwrap of WETH is expected to send native ETH.
        if (msg.sender != weth && msg.sender != address(poolManager)) revert NotAuthorized();
    }

    // ------------------------------------------------------------------ administration

    /// @notice Sets the hook (once). The hook is also a fee source and the only pool registrar.
    function setHook(address hook_) external onlyOwner {
        if (hook_ == address(0)) revert ZeroAddress();
        if (hook != address(0)) revert HookAlreadySet();
        hook = hook_;
        isSource[hook_] = true;
        emit HookSet(hook_);
        emit SourceSet(hook_, true);
    }

    /// @notice Allows or disallows an account (hook, LP locker) to deliver fees.
    function setSource(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isSource[account] = allowed;
        emit SourceSet(account, allowed);
    }

    /// @notice Sets the maximum slippage versus spot in basis points.
    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING_BPS) revert InvalidSlippage(bps);
        maxSlippageBps = bps;
        emit MaxSlippageBpsUpdated(bps);
    }

    /// @notice Sets the maximum tick distance between spot and its reference.
    /// @dev Also resets `maxDriftTicks` to half of it (the constructor default), so the drift
    ///      band and anchor rate scale with the guard and never exceed it. The per hop reference
    ///      step cap is derived from it (a tenth, at least one tick). Call `setMaxDriftTicks`
    ///      afterwards for another ratio.
    function setMaxDeviationTicks(uint256 ticks) external onlyOwner {
        if (ticks > MAX_TICK_SPAN) revert InvalidDeviation(ticks);
        maxDeviationTicks = ticks;
        maxDriftTicks = ticks / 2;
        emit MaxDeviationTicksUpdated(ticks);
        emit MaxDriftTicksUpdated(ticks / 2);
    }

    /// @notice Sets the half width of the anchor band, which is also the most the anchor moves
    ///         per `ANCHOR_PERIOD`. Zero pins the reference to the anchor.
    function setMaxDriftTicks(uint256 ticks) external onlyOwner {
        if (ticks > maxDeviationTicks) revert InvalidDrift(ticks);
        maxDriftTicks = ticks;
        emit MaxDriftTicksUpdated(ticks);
    }

    /// @notice Sets the deviation and slippage bounds of claim conversions run inside a trader's
    ///         swap. Each is further capped by the general bound when used.
    function setInSwapBounds(uint256 deviationTicks, uint256 slippageBps) external onlyOwner {
        if (slippageBps > MAX_SLIPPAGE_CEILING_BPS) revert InvalidSlippage(slippageBps);
        if (deviationTicks > MAX_TICK_SPAN) revert InvalidDeviation(deviationTicks);
        inSwapMaxDeviationTicks = deviationTicks;
        inSwapMaxSlippageBps = slippageBps;
        emit InSwapBoundsUpdated(deviationTicks, slippageBps);
    }

    /// @notice Seeds the reference of route pools with their current spot tick.
    /// @dev Owner judgement: only seed while the pool trades at a fair price. Also used to
    ///      re-anchor a pool after a legitimate large move (for example an Ondo reopening gap).
    function seedReferences(PoolKey[] calldata keys) external onlyOwner {
        for (uint256 i; i < keys.length; ++i) {
            PoolId id = keys[i].toId();
            (uint160 sqrtPriceX96, int24 tick) = _spot(keys[i], id);
            if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);
            references[id] =
                Reference(tick, uint40(block.timestamp), true, tick, uint40(block.timestamp));
            emit ReferenceSet(id, tick);
        }
    }

    /// @notice Sets a pool reference explicitly (for example from an external price).
    function setReference(PoolKey calldata key, int24 tick) external onlyOwner {
        PoolId id = key.toId();
        references[id] =
            Reference(tick, uint40(block.timestamp), true, tick, uint40(block.timestamp));
        emit ReferenceSet(id, tick);
    }

    /// @notice Moves the reference of route pool `key` toward its current spot, exactly as a
    ///         successful hop would (time weighted, capped step, clamped to the anchor band).
    ///         Permissionless, so a reference keeps following a market whose conversions fail the
    ///         price guards. A single manipulated spot moves it by at most one capped step.
    function syncReference(PoolKey calldata key) external nonReentrant returns (int24 tick) {
        PoolId id = key.toId();
        if (!references[id].set) revert ReferenceNotSet(id);
        (uint160 sqrtPriceX96, int24 spot) = _spot(key, id);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);
        _moveReference(id, spot);
        tick = references[id].tick;
        emit ReferenceSynced(id, spot, tick);
    }

    /// @notice Sends balances not owed to any token (dust, accidental transfers) to `to`.
    function rescueExcess(address currency, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(currency).balanceOf(address(this));
        uint256 owed = totalHeld(currency);
        if (balance <= owed) revert NothingToRescue(currency);
        uint256 excess = balance - owed;
        IERC20(currency).safeTransfer(to, excess);
        emit Rescued(currency, to, excess);
    }

    // ------------------------------------------------------------------ pool registration

    /// @notice Records the pool of a launched token. Called by the hook when the pool initializes.
    function registerPool(address token, PoolKey calldata key) external {
        if (msg.sender != hook) revert NotAuthorized();
        if (quoteOf[token] != address(0)) revert PoolAlreadyRegistered(token);
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        address quote = c0 == token ? c1 : c0;
        if (c0 != token && c1 != token) revert InvalidCurrency(token, token);
        if (quote == settlementAsset || token == settlementAsset) revert QuoteNotRoutable(quote);
        if (!quoteRegistry.isAllowed(quote) || quoteRegistry.routeOf(quote).length == 0) {
            revert QuoteNotRoutable(quote);
        }
        _poolKeys[token] = key;
        quoteOf[token] = quote;
        emit PoolRegistered(token, quote, key.toId());
    }

    /// @notice The pool key registered for `token`.
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        if (quoteOf[token] == address(0)) revert UnknownToken(token);
        return _poolKeys[token];
    }

    // ------------------------------------------------------------------ consolidation

    /// @inheritdoc IFeeConsolidator
    function consolidate(address token, address currency, uint256 amount) external nonReentrant {
        if (!_receive(token, currency, amount)) return;
        uint256 total = _hold(token, currency, governor.currentEpoch(), amount);
        _attempt(token, currency, total);
    }

    /// @inheritdoc IFeeConsolidator
    function consolidateAccrued(
        address token,
        address currency,
        uint256 amount,
        uint256 accruedSince
    ) external nonReentrant {
        if (!_receive(token, currency, amount)) return;
        _holdOver(token, currency, amount, accruedSince);
        _attempt(token, currency, _holdings[token][currency].total);
    }

    /// @inheritdoc IFeeConsolidator
    /// @dev Reverts with the route's reason on failure, so the caller learns why.
    function retry(address token, address currency)
        external
        nonReentrant
        returns (uint256 settlementOut)
    {
        return _retry(token, currency, _holdings[token][currency].total);
    }

    /// @notice Like `retry` but consolidates only `amount` (for balances too large for the pool).
    function retryAmount(address token, address currency, uint256 amount)
        external
        nonReentrant
        returns (uint256 settlementOut)
    {
        return _retry(token, currency, amount);
    }

    /// @inheritdoc IFeeConsolidator
    /// @dev Never reverts on a route failure (it emits `ConsolidationFailed`). Swaps the whole
    ///      held balance of a currency, oldest tags first, so dust of an old epoch travels with
    ///      newer fees; `retryAmount` remains for a balance too large for the pool.
    function flushThrough(address token, uint256 epoch) external nonReentrant returns (bool clear) {
        address quote = quoteOf[token];
        // Nothing can be held for a token without a pool.
        if (quote == address(0)) return true;
        bool locked = !poolManager.isUnlocked();
        clear = _flushCurrency(token, token, epoch, locked);
        if (!_flushCurrency(token, quote, epoch, locked)) clear = false;
    }

    /// @inheritdoc IFeeConsolidator
    function heldFees(address token, address currency) external view returns (uint256) {
        return _holdings[token][currency].total;
    }

    /// @inheritdoc IFeeConsolidator
    function heldFeesIn(address token, address currency, uint256 epoch)
        external
        view
        returns (uint256)
    {
        Holding memory h = _holdings[token][currency];
        if (h.total == 0 || epoch > h.last) return 0;
        if (epoch == h.last) return h.total - h.older;
        return _heldIn[token][currency][epoch];
    }

    /// @inheritdoc IFeeConsolidator
    function heldThrough(address token, address currency, uint256 epoch)
        public
        view
        returns (bool)
    {
        Holding memory h = _holdings[token][currency];
        if (h.total == 0 || h.first > epoch) return false;
        // The newest part is never empty while anything is held (older parts are spent first).
        if (h.last <= epoch) return true;
        mapping(uint256 => uint256) storage parts = _heldIn[token][currency];
        for (uint256 e = h.first; e <= epoch; ++e) {
            if (parts[e] != 0) return true;
        }
        return false;
    }

    /// @notice Raw amount of `currency` owed to all tokens (held, not yet consolidated).
    function totalHeld(address currency) public view returns (uint256) {
        uint256 stored = _owedPlusOne[currency];
        return stored == 0 ? 0 : stored - 1;
    }

    /// @notice Executes a route. Callable by this contract only, so failures can be caught.
    function execute(address token, address currency, uint256 amount)
        external
        onlySelf
        returns (uint256)
    {
        return _execute(token, currency, amount);
    }

    /// @dev Checks a delivery and books it as owed. Returns false for a zero amount.
    function _receive(address token, address currency, uint256 amount) private returns (bool) {
        if (!isSource[msg.sender]) revert NotAuthorized();
        address quote = quoteOf[token];
        if (quote == address(0)) revert UnknownToken(token);
        if (currency != token && currency != quote) revert InvalidCurrency(token, currency);
        if (amount == 0) return false;

        uint256 owed = totalHeld(currency) + amount;
        _owedPlusOne[currency] = owed + 1;
        // Never account for what was not delivered.
        uint256 balance = IERC20(currency).balanceOf(address(this));
        if (balance < owed) revert UnbackedDeposit(currency, balance, owed);
        return true;
    }

    /// @dev Adds `amount` to the held balance, tagged with accrual `epoch`. Returns the new
    ///      held total.
    function _hold(address token, address currency, uint256 epoch, uint256 amount)
        private
        returns (uint256)
    {
        Holding memory h = _holdings[token][currency];
        if (amount == 0) return h.total;
        uint24 e = epoch.toUint24();
        if (h.total == 0) {
            h.first = e;
            h.last = e;
            h.older = 0;
        } else if (e > h.last) {
            // A newer epoch: the current newest part moves to `_heldIn` (once per epoch).
            _heldIn[token][currency][h.last] = h.total - h.older;
            h.older = h.total;
            h.last = e;
        } else if (e < h.last) {
            _heldIn[token][currency][e] += amount;
            if (h.older == 0 || e < h.first) h.first = e;
            h.older = (uint256(h.older) + amount).toUint104();
        }
        uint256 total = uint256(h.total) + amount;
        h.total = total.toUint104();
        _holdings[token][currency] = h;
        return total;
    }

    /// @dev Spreads `amount`, earned evenly over `[since, now]`, across the epochs of that
    ///      interval by the time each covers. The oldest epoch takes the rounding remainder.
    function _holdOver(address token, address currency, uint256 amount, uint256 since) private {
        uint256 current = governor.currentEpoch();
        uint256 oldest = current >= MAX_ACCRUAL_EPOCHS ? current - (MAX_ACCRUAL_EPOCHS - 1) : 0;
        uint256 floor = governor.epochStart(oldest);
        if (since < floor) since = floor;
        if (since >= block.timestamp) {
            _hold(token, currency, current, amount);
            return;
        }

        uint256 total = block.timestamp - since;
        uint256 remaining = amount;
        uint256 end = block.timestamp;
        for (uint256 epoch = current;; --epoch) {
            uint256 start = governor.epochStart(epoch);
            if (start > end) start = end;
            if (start <= since || epoch == oldest) {
                _hold(token, currency, epoch, remaining);
                return;
            }
            uint256 part = FullMath.mulDiv(amount, end - start, total);
            _hold(token, currency, epoch, part);
            remaining -= part;
            end = start;
        }
    }

    /// @dev Takes `amount` (at most the held total) from the held balance, oldest accrual epoch
    ///      first, and returns the parts taken with their epochs.
    function _release(address token, address currency, uint256 amount)
        private
        returns (uint256[] memory epochs, uint256[] memory parts)
    {
        Holding memory h = _holdings[token][currency];
        _owedPlusOne[currency] -= amount;

        // Every part is tagged between `first` and `last`, so this many slots always suffice.
        uint256 slots = uint256(h.last) - h.first + 1;
        epochs = new uint256[](slots);
        parts = new uint256[](slots);
        uint256 count;
        uint256 remaining = amount;
        uint256 e = h.first;
        mapping(uint256 => uint256) storage older = _heldIn[token][currency];
        while (remaining != 0 && h.older != 0) {
            uint256 bucket = older[e];
            if (bucket != 0) {
                uint256 take = bucket < remaining ? bucket : remaining;
                older[e] = bucket - take;
                h.older -= uint104(take);
                epochs[count] = e;
                parts[count] = take;
                ++count;
                remaining -= take;
                if (take < bucket) break;
            }
            ++e;
        }
        if (remaining != 0) {
            // The rest comes from the newest part (`amount` never exceeds the total).
            epochs[count] = h.last;
            parts[count] = remaining;
            ++count;
        }
        h.first = h.older == 0 ? h.last : uint24(e);
        h.total -= uint104(amount);
        _holdings[token][currency] = h;
        assembly ("memory-safe") {
            mstore(epochs, count)
            mstore(parts, count)
        }
    }

    function _retry(address token, address currency, uint256 amount) private returns (uint256) {
        uint256 held = _holdings[token][currency].total;
        if (held == 0 || amount == 0) revert NothingToConsolidate(token, currency);
        if (amount > held) revert AmountExceedsHeld(amount, held);
        if (poolManager.isUnlocked()) revert PoolManagerBusy();
        return _execute(token, currency, amount);
    }

    /// @dev Tries to swap the whole held balance of `currency` if any part of it is tagged
    ///      `epoch` or older. Returns whether no such part is held afterwards.
    function _flushCurrency(address token, address currency, uint256 epoch, bool locked)
        private
        returns (bool)
    {
        if (!heldThrough(token, currency, epoch)) return true;
        if (!locked) return false;
        uint256 amount = _holdings[token][currency].total;
        try this.execute(token, currency, amount) returns (uint256) {
            return true;
        } catch (bytes memory reason) {
            emit ConsolidationFailed(token, currency, amount, reason);
            return false;
        }
    }

    function _attempt(address token, address currency, uint256 amount) private {
        if (amount == 0) return;
        if (poolManager.isUnlocked()) {
            // Inside a pool manager flow (the hook during a swap): hold and settle later.
            emit ConsolidationFailed(
                token, currency, amount, abi.encodeWithSelector(PoolManagerBusy.selector)
            );
            return;
        }
        try this.execute(token, currency, amount) returns (uint256) {}
        catch (bytes memory reason) {
            emit ConsolidationFailed(token, currency, amount, reason);
        }
    }

    /// @dev Swaps `amount` of held `currency` and credits the output to the accrual epochs of
    ///      the parts spent, in proportion (the newest part takes the rounding remainder), in
    ///      one vault deposit. A dust amount whose route rounds to zero output is consumed and
    ///      credits nothing (every hop's minimum output is then zero, so no amount that is worth
    ///      something can end like this).
    function _execute(address token, address currency, uint256 amount)
        private
        returns (uint256 out)
    {
        (uint256[] memory epochs, uint256[] memory parts) = _release(token, currency, amount);

        // `currency` is the token or its quote asset, never the settlement asset itself.
        bytes memory result = poolManager.unlock(abi.encode(token, currency, amount));
        out = abi.decode(result, (uint256));

        if (out != 0) {
            IERC20(settlementAsset).safeTransfer(address(vault), out);
            // Each part becomes its share of the output; the last one takes the remainder.
            uint256 n = parts.length;
            uint256 left = out;
            for (uint256 i; i + 1 < n; ++i) {
                uint256 share = FullMath.mulDiv(out, parts[i], amount);
                parts[i] = share;
                left -= share;
            }
            parts[n - 1] = left;
            vault.depositFees(token, epochs, parts);
        }
        emit FeesConsolidated(token, currency, amount, out);
    }

    /// @inheritdoc IFeeConsolidator
    /// @dev For the live-donation hook, which holds its fees as ERC-6909 claims and converts them
    ///      inside the pool manager flow it is already in (a swap, or its own unlock for retries).
    ///      Burning the caller's claims as its operator credits this contract with `amount` of
    ///      `currency`; every hop is the same `_hop` as consolidation (reference-tick guard,
    ///      slippage and hop-fee bound, full fill, reference move), with the in-swap bounds when
    ///      `inSwap` (the trader chooses when an in-line conversion runs and can move route pools
    ///      in the same transaction, so it gets the tightest guard), and the settlement asset is
    ///      taken straight to `to`. Every pool manager delta of this contract is zero when it
    ///      returns. Never calls `sync`; the only `settle` is the native one inside the WETH
    ///      unwrap hop, so the caller must make sure no currency is synced (the live hook checks).
    ///      The token-pool TWAP guard is not used: the claims are never in a launched token.
    function convertClaims(address currency, uint256 amount, address to, bool inSwap)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (!isSource[msg.sender]) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingToConsolidate(address(0), currency);
        if (!poolManager.isUnlocked()) revert PoolManagerLocked();
        PoolKey[] memory route = quoteRegistry.routeOf(currency);
        if (route.length == 0) revert NoRoute(currency);

        poolManager.burn(msg.sender, Currency.wrap(currency).toId(), amount);
        address current = currency;
        out = amount;
        for (uint256 i; i < route.length; ++i) {
            if (inSwap && address(route[i].hooks) != address(0)) revert HookedRouteHop(i);
            (current, out) = _hop(route[i], current, out, address(0), false, inSwap);
        }
        if (current != settlementAsset) revert NoRoute(currency);
        if (out == 0) revert SlippageTooHigh(0, 1);

        poolManager.take(Currency.wrap(settlementAsset), to, out);
        emit ClaimsConverted(msg.sender, currency, to, amount, out);
    }

    // ------------------------------------------------------------------ unlock callback

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAuthorized();
        (address token, address currencyIn, uint256 amountIn) =
            abi.decode(data, (address, address, uint256));

        PoolKey[] memory route = _routeFor(token, currencyIn);
        bool tokenHop = currencyIn == token;

        // Pay the input into the pool manager.
        poolManager.sync(Currency.wrap(currencyIn));
        IERC20(currencyIn).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();

        address current = currencyIn;
        uint256 amount = amountIn;
        for (uint256 i; i < route.length; ++i) {
            (current, amount) = _hop(route[i], current, amount, token, tokenHop && i == 0, false);
        }
        if (current != settlementAsset) revert NoRoute(currencyIn);

        poolManager.take(Currency.wrap(current), address(this), amount);
        return abi.encode(amount);
    }

    function _routeFor(address token, address currency)
        private
        view
        returns (PoolKey[] memory route)
    {
        address quote = quoteOf[token];
        PoolKey[] memory quoteRoute = quoteRegistry.routeOf(quote);
        if (quoteRoute.length == 0) revert NoRoute(quote);
        if (currency == quote) return quoteRoute;
        if (currency != token) revert InvalidCurrency(token, currency);

        route = new PoolKey[](quoteRoute.length + 1);
        route[0] = _poolKeys[token];
        for (uint256 i; i < quoteRoute.length; ++i) {
            route[i + 1] = quoteRoute[i];
        }
    }

    /// @dev Swaps `amount` of `current` exact-input through `key`, applying the price guards.
    ///      `inSwap` selects the in-swap deviation and slippage bounds.
    function _hop(
        PoolKey memory key,
        address current,
        uint256 amount,
        address token,
        bool tokenHop,
        bool inSwap
    ) private returns (address next, uint256 out) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);

        // WETH to a native ETH pool: unwrap inside the unlock.
        if (current == weth && c0 != weth && c1 != weth) {
            poolManager.take(Currency.wrap(weth), address(this), amount);
            IWETH(weth).withdraw(amount);
            poolManager.settle{value: amount}();
            current = address(0);
        }

        bool zeroForOne = current == c0;
        if (!zeroForOne && current != c1) revert NoRoute(current);

        bool v3 = V3RouteLib.isV3(key);
        (uint256 minOut, int24 tick) =
            _prepare(key, v3, amount, zeroForOne, token, tokenHop, inSwap);

        out = v3 ? _hopV3(key, zeroForOne, amount) : _swapV4(key, zeroForOne, amount);
        if (out < minOut) revert SlippageTooHigh(out, minOut);

        if (!tokenHop) _moveReference(key.toId(), tick);
        next = zeroForOne ? c1 : c0;
    }

    /// @dev Reads the pool, runs the deviation guard of a hop and returns the least output the hop
    ///      may produce together with the spot tick.
    function _prepare(
        PoolKey memory key,
        bool v3,
        uint256 amount,
        bool zeroForOne,
        address token,
        bool tokenHop,
        bool inSwap
    ) private view returns (uint256 minOut, int24 tick) {
        PoolId id = key.toId();
        uint160 sqrtPriceX96;
        uint24 lpFee;
        (sqrtPriceX96, tick, lpFee) = _slot0(key, id, v3);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);

        uint256 slippage = maxSlippageBps;
        uint256 deviation = maxDeviationTicks;
        if (inSwap) {
            if (inSwapMaxSlippageBps < slippage) slippage = inSwapMaxSlippageBps;
            if (inSwapMaxDeviationTicks < deviation) deviation = inSwapMaxDeviationTicks;
        }
        int24 referenceTick = _checkDeviation(key, id, tick, token, tokenHop, deviation);

        // Expected output at the better of spot and the reference: a spot pushed below the
        // reference (inside the band) does not lower the minimum.
        uint256 expected = _quote(amount, sqrtPriceX96, zeroForOne);
        uint256 atReference = _quote(amount, TickMath.getSqrtPriceAtTick(referenceTick), zeroForOne);
        if (atReference > expected) expected = atReference;
        uint256 tolerance = slippage + _hopFeeBps(key, lpFee, token, tokenHop);
        minOut = (expected * (BPS - tolerance)) / BPS;
    }

    /// @dev Spot state of the pool of a hop (a v3 hop has no dynamic fee, so `lpFee` is zero).
    function _slot0(PoolKey memory key, PoolId id, bool v3)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 lpFee)
    {
        if (v3) {
            (sqrtPriceX96, tick) = _v3Spot(key);
        } else {
            (sqrtPriceX96, tick,, lpFee) = poolManager.getSlot0(id);
        }
    }

    /// @dev Exact-input swap through a v4 pool inside the unlock; requires a full fill.
    function _swapV4(PoolKey memory key, bool zeroForOne, uint256 amount)
        private
        returns (uint256 out)
    {
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (spent >= 0 || uint256(uint128(-spent)) != amount) {
            revert PartialFill(spent >= 0 ? 0 : uint256(uint128(-spent)), amount);
        }
        out = received > 0 ? uint256(uint128(received)) : 0;
    }

    /// @dev Spot of a route pool, v3 or v4 (a v3 hop has no pool manager state).
    function _spot(PoolKey memory key, PoolId id)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tick)
    {
        if (V3RouteLib.isV3(key)) return _v3Spot(key);
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(id);
    }

    /// @dev A v3 hop inside the pool manager flow. The input is a credit of this contract at the
    ///      pool manager: it is taken out, swapped on the v3 pool, and the output is paid back in
    ///      as a credit, so the next hop (or the final `take`) sees the same accounting as after a
    ///      v4 hop. Every delta of this contract at the pool manager is unchanged by the pair
    ///      except for the swapped currency pair, exactly as after a v4 swap.
    function _hopV3(PoolKey memory key, bool zeroForOne, uint256 amount)
        private
        returns (uint256 out)
    {
        address tokenIn = Currency.unwrap(zeroForOne ? key.currency0 : key.currency1);
        address tokenOut = Currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        poolManager.take(Currency.wrap(tokenIn), address(this), amount);
        out = _v3Swap(key, zeroForOne, amount);
        if (out != 0) {
            poolManager.sync(Currency.wrap(tokenOut));
            IERC20(tokenOut).safeTransfer(address(poolManager), out);
            poolManager.settle();
        }
    }

    /// @dev Spot of a v3 pool as `(sqrtPriceX96, tick)`; zero when the pool does not exist.
    ///      Overridden by `FeeConsolidatorV3`; the base contract routes through v4 only.
    function _v3Spot(PoolKey memory) internal view virtual returns (uint160, int24) {
        revert V3Unsupported();
    }

    /// @dev Exact-input swap of `amount` on the v3 pool of `key`; reverts unless the whole amount
    ///      is spent, and returns the output received. Overridden by `FeeConsolidatorV3`.
    function _v3Swap(PoolKey memory, bool, uint256) internal virtual returns (uint256) {
        revert V3Unsupported();
    }

    /// @dev Output of `amount` at price `sqrtPriceX96`, before fees and impact.
    function _quote(uint256 amount, uint160 sqrtPriceX96, bool zeroForOne)
        private
        pure
        returns (uint256)
    {
        return zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
    }

    /// @dev Reverts unless `spotTick` is within `maxTicks` of the hop's reference; returns it.
    function _checkDeviation(
        PoolKey memory key,
        PoolId id,
        int24 spotTick,
        address token,
        bool tokenHop,
        uint256 maxTicks
    ) private view returns (int24 referenceTick) {
        if (tokenHop) {
            (bool ok, int24 twap,) = IHookOracle(address(key.hooks)).twapTick(token, TWAP_WINDOW);
            if (!ok) revert OracleUnavailable(token);
            referenceTick = twap;
        } else {
            Reference memory ref = references[id];
            if (!ref.set) revert ReferenceNotSet(id);
            referenceTick = ref.tick;
        }
        int256 diff = int256(spotTick) - int256(referenceTick);
        if (uint256(diff < 0 ? -diff : diff) > maxTicks) {
            revert PriceDeviation(spotTick, referenceTick);
        }
    }

    /// @dev After a successful hop or a `syncReference`: first moves the anchor toward the
    ///      reference by at most `maxDriftTicks` per `ANCHOR_PERIOD` of elapsed time (one period
    ///      at most counts), then moves the reference toward spot by the elapsed fraction of
    ///      `REFERENCE_WINDOW`, each step capped at a tenth of `maxDeviationTicks` (at least one
    ///      tick), and clamps it to `anchor ± maxDriftTicks`.
    ///      A clock whose step rounds to zero keeps its elapsed time, so frequent moves (an
    ///      in-line conversion on every swap) still add up and cannot freeze the reference. A
    ///      clock already at its target restarts, so a quiet pool banks nothing.
    function _moveReference(PoolId id, int24 spotTick) private {
        Reference memory r = references[id];
        int256 drift = int256(maxDriftTicks); // at most MAX_TICK_SPAN
        uint256 nowTs = block.timestamp;

        int256 gap = int256(r.tick) - int256(r.anchor);
        if (gap == 0) {
            r.anchoredAt = uint40(nowTs);
        } else {
            uint256 dt = nowTs - r.anchoredAt;
            if (dt > ANCHOR_PERIOD) dt = ANCHOR_PERIOD;
            int256 allowance = (drift * int256(dt)) / int256(ANCHOR_PERIOD);
            if (allowance != 0) {
                if (gap > allowance) gap = allowance;
                if (gap < -allowance) gap = -allowance;
                r.anchor = int24(int256(r.anchor) + gap);
                r.anchoredAt = uint40(nowTs);
            }
        }

        int256 diff = int256(spotTick) - int256(r.tick);
        if (diff == 0) {
            // Already at spot: nothing is owed for the elapsed time.
            r.updatedAt = uint40(nowTs);
        } else {
            uint256 dt = nowTs - r.updatedAt;
            if (dt > REFERENCE_WINDOW) dt = REFERENCE_WINDOW;
            int256 step = (diff * int256(dt)) / int256(REFERENCE_WINDOW);
            if (step != 0) {
                int256 cap = int256(maxDeviationTicks / 10);
                if (cap == 0) cap = 1;
                if (step > cap) step = cap;
                if (step < -cap) step = -cap;
                r.tick = int24(int256(r.tick) + step);
                r.updatedAt = uint40(nowTs);
            }
        }

        // Keep the reference in the band (also after the owner narrows `maxDriftTicks`).
        int256 lo = int256(r.anchor) - drift;
        int256 hi = int256(r.anchor) + drift;
        if (lo < TickMath.MIN_TICK) lo = TickMath.MIN_TICK;
        if (hi > TickMath.MAX_TICK) hi = TickMath.MAX_TICK;
        if (r.tick < lo) r.tick = int24(lo);
        if (r.tick > hi) r.tick = int24(hi);
        references[id] = r;
    }

    /// @dev Pool fee of a hop in basis points, rounded up.
    function _hopFeeBps(PoolKey memory key, uint24 lpFee, address token, bool tokenHop)
        private
        view
        returns (uint256 feeBps)
    {
        if (tokenHop) {
            // The token pool uses an overridden dynamic fee equal to the token's base fee.
            feeBps = IVaradaHook(address(key.hooks)).feeConfig(token).baseFeeBps;
        } else {
            uint256 pips = LPFeeLibrary.isDynamicFee(key.fee) ? lpFee : key.fee;
            feeBps = (pips + 99) / 100;
        }
        if (feeBps > MAX_HOP_FEE_BPS) revert HopFeeTooHigh(feeBps);
    }
}
