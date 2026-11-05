// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {IConsolidatorRegistry} from "./FeeConsolidator.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {ILiveDonationVault} from "./interfaces/ILiveDonationVault.sol";
import {IRotationGovernor} from "./interfaces/IRotationGovernor.sol";
import {IVeradaLiveHook} from "./interfaces/IVeradaLiveHook.sol";
import {FeeScheduleLib} from "./libraries/FeeScheduleLib.sol";

/// @dev Registry getter of the fee consolidator (not part of `IFeeConsolidator`).
interface IConsolidatorRoutes {
    function quoteRegistry() external view returns (IConsolidatorRegistry);
}

/// @title VeradaLiveHook
/// @notice Uniswap v4 hook of live-donation tokens: every swap pays a fee in the quote currency,
///         which is converted to USDC inside the same swap and credited to the cause active at
///         that moment. Nothing about the conversion or the donation can revert a trader's swap.
/// @dev Fee model. The pool's LP fee is overridden to 0 (the locked position earns nothing). The
///      fee is `b = baseFeeBps + launch surcharge(now)` (at most 8500 bps) of the gross quote flow
///      of the swap, rounded up:
///       - quote is the specified currency (exact-in buy, exact-out sell): taken in `beforeSwap`
///         through the specified return delta (`feeOnGross(A)` out of the input, or
///         `feeGrossUp(A)` on top of the output); `afterSwap` requires a full fill.
///       - quote is the unspecified currency (exact-in sell, exact-out buy): taken in `afterSwap`
///         through the unspecified return delta (`feeOnGross(G)` of the output, or
///         `feeGrossUp(I)` on top of the input).
///
///      In-swap conversion (afterSwap). The hook mints itself `f` ERC-6909 claims of the quote
///      (pure accounting: its delta becomes `-f`, cancelled when the pool manager applies the
///      hook's `+f` return delta). Then, unless a currency is synced (a router mid-settlement),
///      a gas-capped self call (`inlineConvert`) asks the consolidator to burn those claims and
///      swap them along the quote's hookless registry route under the consolidator's in-swap price
///      guards (tight deviation and slippage bounds, measured against the route reference, so a
///      route pool pushed before the swap makes the conversion fail and the fee is held rather
///      than sold cheaply), paying USDC to the vault, and credits the vault. If anything fails, the frame is rolled back and
///      the claims stay with the hook as `heldRaw[token][cause]`, attributed to the cause active
///      when they were earned; anyone can `retryHeld` them later.
///
///      Gas. The trader's swap needs `LIVE_GAS_REQUIRED` gas left at `afterSwap` whenever a fee
///      is due. The requirement does not depend on state, so `eth_estimateGas` finds it; with less
///      the swap reverts `InsufficientGas` rather than silently skipping the donation.
///
///      Invariants:
///       - H1: `poolManager.balanceOf(this, id(q)) == totalHeld[q] == sum of heldRaw[t][c]` over
///         tokens quoted in `q`.
///       - H2: every fee is either converted and credited in the same swap, or held in full.
///         A retry lowers `heldRaw` by exactly the claims it burns.
///       - H3: when `afterSwap` returns, this hook's delta is `-f` in the quote and zero elsewhere,
///         and the consolidator's and the vault's deltas are zero. The swap never ends with an
///         unsettled delta caused by this hook.
///       - H4: the only reverts this hook adds to a swap are `InsufficientGas`,
///         `PartialFillNotSupported` and `SwapReentered`. Every `donate` to a live pool reverts
///         (`DonateNotAllowed`), so the locked position never accrues anything to collect.
///       - H5: the swap path is O(1): at most `QuoteRegistry.MAX_ROUTE_LENGTH` (3) hops, one push,
///         O(1) governor reads, and it never calls `sync`.
///
///      Reentrancy. Callbacks are pool-manager only. A transient lock (0 idle, 1 swap, 2 retry)
///      makes a nested swap on any live pool revert (so route or Endaoment code cannot re-enter
///      a live pool), lets `unlockCallback` run only for this hook's own retry unlock, and keeps
///      `retryHeld` out of any swap. `inlineConvert` is self-only and called through a gas-capped
///      try with a bare catch (no return-data copy). Deltas are per caller, so no callee can
///      spend this hook's deltas.
///
///      The hook has no owner. Its address must encode the permission flags (see
///      `getHookPermissions`); mine a salt with the HookMiner library before deploying.
contract VeradaLiveHook is IHooks, IVeradaLiveHook, IUnlockCallback {
    using SafeCast for uint256;
    using TransientStateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice `rotation` reported for credits of retried held fees.
    uint64 public constant RETRY_ROTATION = type(uint64).max;
    /// @notice `failure` reported when the conversion was skipped because a currency was synced.
    bytes4 public constant SYNCED_CURRENCY_PENDING = bytes4(keccak256("SyncedCurrencyPending()"));

    /// @notice Gas forwarded to the in-swap conversion (`inlineConvert`): up to three route hops
    ///         including the WETH unwrap, the vault credit and a capped push.
    /// @dev Measured with cold storage (test/live/LiveGas.t.sol): `convertClaims` 141k for one
    ///      hop and 302k for three hops with the unwrap, `creditLive` 40k, a push to a deployed
    ///      org 165k. 1.25x the realistic maximum (about 517k) is about 650k, which also covers
    ///      three hops, the credit and a push that burns its whole 220k cap (about 592k).
    uint256 public constant INLINE_GAS_BUDGET = 650_000;
    /// @notice Gas used between the gas check and the try (governor view, mint, precheck);
    ///         about 33k measured.
    uint256 public constant PRE_TRY_GAS = 40_000;
    /// @notice Gas kept for the hold path after a failed try (two fresh slots, event, return);
    ///         about 50k measured.
    uint256 public constant FALLBACK_RESERVE = 70_000;
    /// @notice Gas required at `afterSwap` when a fee is due (770,317).
    /// @dev The trader's gas limit must leave this much at `afterSwap`. Through the v4 test
    ///      router that is a limit of about 0.86M for a converted swap; the swap itself then uses
    ///      about 0.29M (threshold above the credit) to 0.40M (push in the swap).
    uint256 public constant LIVE_GAS_REQUIRED =
        PRE_TRY_GAS + (INLINE_GAS_BUDGET * 64) / 63 + FALLBACK_RESERVE;

    uint256 internal constant LOCK_IDLE = 0;
    uint256 internal constant LOCK_SWAP = 1;
    uint256 internal constant LOCK_RETRY = 2;
    /// @dev Transient slot of the lock.
    bytes32 internal constant LOCK_SLOT = bytes32(uint256(keccak256("verada.live.hook.lock")) - 1);

    IPoolManager public immutable poolManager;
    /// @notice The factory, the only account allowed to configure tokens and create pools.
    address public immutable factory;
    IFeeConsolidator public immutable consolidator;
    IConsolidatorRegistry public immutable quoteRegistry;
    IRotationGovernor public immutable rotationGovernor;
    ILiveDonationVault internal immutable _vault;
    /// @notice The settlement asset (USDC).
    address public immutable usdc;

    /// @notice Fee configuration and pool state of a token.
    /// @dev Slot A (136 bits) is read once per swap callback; `quote` (slot B) only by `retryHeld`
    ///      and views.
    struct TokenState {
        uint24 baseFeeBps;
        uint24 launchSurchargeBps;
        uint32 surchargeDecaySeconds;
        uint40 launchTimestamp;
        bool configured;
        bool initialized;
        address quote;
    }

    mapping(address token => TokenState) internal _tokens;
    /// @inheritdoc IVeradaLiveHook
    mapping(address token => mapping(bytes32 causeId => uint256)) public heldRaw;
    /// @inheritdoc IVeradaLiveHook
    mapping(address quote => uint256) public totalHeld;

    /// @dev Per-swap case: which side is the quote, and how the fee is taken.
    struct SwapCase {
        bool quoteIs0;
        bool specifiedIs0;
        bool specifiedIsQuote;
        bool exactIn;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @param poolManager_ Uniswap v4 pool manager.
    /// @param factory_ The Verada factory.
    /// @param consolidator_ Fee consolidator (routes and price guards); must list this hook as a
    ///        source before conversions succeed.
    /// @param rotationGovernor_ Rotation governor (active cause).
    /// @param vault_ Live-donation vault (USDC ledger).
    constructor(
        IPoolManager poolManager_,
        address factory_,
        IFeeConsolidator consolidator_,
        IRotationGovernor rotationGovernor_,
        ILiveDonationVault vault_
    ) {
        if (
            address(poolManager_) == address(0) || factory_ == address(0)
                || address(consolidator_) == address(0) || address(rotationGovernor_) == address(0)
                || address(vault_) == address(0)
        ) revert ZeroAddress();
        address settlement = consolidator_.settlementAsset();
        if (settlement == address(0) || vault_.usdc() != settlement) revert SettlementMismatch();
        IConsolidatorRegistry registry = IConsolidatorRoutes(address(consolidator_)).quoteRegistry();
        if (address(registry) == address(0)) revert ZeroAddress();

        poolManager = poolManager_;
        factory = factory_;
        consolidator = consolidator_;
        quoteRegistry = registry;
        rotationGovernor = rotationGovernor_;
        _vault = vault_;
        usdc = settlement;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
        // The consolidator burns this hook's claims when it converts them.
        poolManager_.setOperator(address(consolidator_), true);
    }

    /// @notice Permission flags this hook's address must encode.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
        // Donations are refused: they would accrue to the locked position, whose fees the LP
        // locker can never forward for a live token (the consolidator does not know it).
        p.beforeDonate = true;
    }

    // ------------------------------------------------------------------ configuration

    /// @inheritdoc IVeradaLiveHook
    function configureToken(address token, LiveFeeConfig calldata cfg) external {
        if (msg.sender != factory) revert NotFactory();
        TokenState storage t = _tokens[token];
        if (t.configured) revert AlreadyConfigured(token);
        FeeScheduleLib.validate(cfg.baseFeeBps, cfg.launchSurchargeBps, cfg.surchargeDecaySeconds);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 launch = cfg.launchTimestamp == 0 ? uint40(block.timestamp) : cfg.launchTimestamp;
        t.baseFeeBps = cfg.baseFeeBps;
        t.launchSurchargeBps = cfg.launchSurchargeBps;
        t.surchargeDecaySeconds = cfg.surchargeDecaySeconds;
        t.launchTimestamp = launch;
        t.configured = true;
        emit TokenConfigured(
            token, cfg.baseFeeBps, cfg.launchSurchargeBps, cfg.surchargeDecaySeconds, launch
        );
    }

    // ------------------------------------------------------------------ hooks

    /// @dev One live pool per token, created by the factory after the token was registered with
    ///      the vault (and so with the governor). The quote must be allowed and routable to USDC.
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        onlyPoolManager
        returns (bytes4)
    {
        address token = _tokenOf(key);
        TokenState storage t = _tokens[token];
        if (
            sender != factory || address(key.hooks) != address(this)
                || !LPFeeLibrary.isDynamicFee(key.fee) || t.initialized
        ) revert InvalidPool();
        address c0 = Currency.unwrap(key.currency0);
        address quote = c0 == token ? Currency.unwrap(key.currency1) : c0;
        if (
            quote == usdc || !quoteRegistry.isAllowed(quote)
                || quoteRegistry.routeOf(quote).length == 0
        ) revert QuoteNotRoutable(quote);
        if (!_vault.isRegistered(token)) revert TokenNotRegistered(token);

        t.initialized = true;
        t.quote = quote;
        emit PoolRegistered(token, quote, PoolId.unwrap(key.toId()));
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address token = _tokenOf(key);
        if (_lock() != LOCK_IDLE) revert SwapReentered();
        _setLock(LOCK_SWAP);

        SwapCase memory sc = _case(key, token, params);
        int128 specified;
        if (sc.specifiedIsQuote) {
            specified = _specifiedFee(sc, params, _feeBps(_tokens[token])).toInt128();
        }
        return (
            IHooks.beforeSwap.selector,
            toBeforeSwapDelta(specified, 0),
            LPFeeLibrary.OVERRIDE_FEE_FLAG // LP fee 0
        );
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        address token = _tokenOf(key);
        SwapCase memory sc = _case(key, token, params);
        // Same block as beforeSwap, so the same fee rate.
        uint256 b = _feeBps(_tokens[token]);

        uint256 f;
        uint256 ret;
        if (sc.specifiedIsQuote) {
            f = _specifiedFee(sc, params, b);
            int128 got = sc.specifiedIs0 ? delta.amount0() : delta.amount1();
            uint256 a = _abs(params.amountSpecified);
            if (sc.exactIn) {
                // The pool must have consumed the whole input net of the fee.
                if (got >= 0 || uint256(uint128(-got)) != a - f) {
                    revert PartialFillNotSupported(got >= 0 ? 0 : uint256(uint128(-got)), a - f);
                }
            } else if (got <= 0 || uint256(uint128(got)) != a + f) {
                revert PartialFillNotSupported(got <= 0 ? 0 : uint256(uint128(got)), a + f);
            }
        } else {
            int128 unspecified = sc.specifiedIs0 ? delta.amount1() : delta.amount0();
            uint256 x =
                unspecified < 0 ? uint256(uint128(-unspecified)) : uint256(uint128(unspecified));
            f = sc.exactIn ? FeeScheduleLib.feeOnGross(x, b) : FeeScheduleLib.feeGrossUp(x, b);
            ret = f;
        }

        if (f != 0) {
            if (gasleft() < LIVE_GAS_REQUIRED) {
                revert InsufficientGas(LIVE_GAS_REQUIRED, gasleft());
            }
            address quote =
                sc.quoteIs0 ? Currency.unwrap(key.currency0) : Currency.unwrap(key.currency1);
            _takeFee(token, quote, f);
        }
        _setLock(LOCK_IDLE);
        return (IHooks.afterSwap.selector, ret.toInt128());
    }

    // ------------------------------------------------------------------ conversion

    /// @inheritdoc IVeradaLiveHook
    /// @dev Burns this hook's claims through the consolidator (hookless route hops only), which
    ///      pays USDC to the vault, then credits the vault. Self only.
    function inlineConvert(
        address token,
        bytes32 causeId,
        uint64 rotation,
        address quote,
        uint256 amount
    ) external returns (uint256 usdcOut) {
        if (msg.sender != address(this)) revert NotSelf();
        usdcOut = consolidator.convertClaims(quote, amount, address(_vault), true);
        _vault.creditLive(token, causeId, rotation, usdcOut);
    }

    /// @inheritdoc IVeradaLiveHook
    /// @dev Chunks are allowed. Hooked route pools are allowed here (as in the weekly retry);
    ///      they cannot reach a live pool because of the lock.
    function retryHeld(address token, bytes32 causeId, uint256 amount)
        external
        returns (uint256 usdcOut)
    {
        if (_lock() != LOCK_IDLE) revert Busy();
        if (poolManager.isUnlocked()) revert PoolManagerBusy();
        if (amount == 0) revert NothingHeld();
        uint256 held = heldRaw[token][causeId];
        if (amount > held) revert AmountExceedsHeld(amount, held);
        address quote = _tokens[token].quote;

        heldRaw[token][causeId] = held - amount;
        totalHeld[quote] -= amount;

        _setLock(LOCK_RETRY);
        bytes memory result = poolManager.unlock(abi.encode(token, causeId, quote, amount));
        _setLock(LOCK_IDLE);
        usdcOut = abi.decode(result, (uint256));
        emit HeldRetried(token, causeId, msg.sender, amount, usdcOut);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _lock() != LOCK_RETRY) revert NotPoolManager();
        (address token, bytes32 causeId, address quote, uint256 amount) =
            abi.decode(data, (address, bytes32, address, uint256));
        uint256 out = consolidator.convertClaims(quote, amount, address(_vault), false);
        _vault.creditLive(token, causeId, RETRY_ROTATION, out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IVeradaLiveHook
    function feeConfig(address token) external view returns (LiveFeeConfig memory) {
        TokenState storage t = _tokens[token];
        return LiveFeeConfig(
            t.baseFeeBps, t.launchSurchargeBps, t.surchargeDecaySeconds, t.launchTimestamp
        );
    }

    /// @inheritdoc IVeradaLiveHook
    function currentFeeBps(address token) external view returns (uint24) {
        TokenState storage t = _tokens[token];
        if (!t.configured) revert TokenNotConfigured(token);
        // At most 8500, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint24(_feeBps(t));
    }

    /// @inheritdoc IVeradaLiveHook
    function quoteOf(address token) external view returns (address) {
        return _tokens[token].quote;
    }

    /// @inheritdoc IVeradaLiveHook
    function configured(address token) external view returns (bool) {
        return _tokens[token].configured;
    }

    /// @inheritdoc IVeradaLiveHook
    function poolInitialized(address token) external view returns (bool) {
        return _tokens[token].initialized;
    }

    /// @inheritdoc IVeradaLiveHook
    function vault() external view returns (address) {
        return address(_vault);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Records `f` of `quote` as this hook's claims, then converts and credits them or holds
    ///      them for the cause active now. Never reverts for a conversion or donation failure.
    function _takeFee(address token, address quote, uint256 f) private {
        (bytes32 causeId, uint64 rotation) = rotationGovernor.activeCause(token);
        // Hook delta -f now; the pool manager applies the +f return delta after this callback.
        poolManager.mint(address(this), Currency.wrap(quote).toId(), f);

        uint256 out;
        bool converted;
        bytes4 failure;
        if (Currency.unwrap(poolManager.getSyncedCurrency()) != address(0)) {
            // A router is between `sync` and `settle`: moving pool manager balances now would
            // break its settlement, so hold.
            failure = SYNCED_CURRENCY_PENDING;
        } else {
            try this.inlineConvert{gas: INLINE_GAS_BUDGET}(
                token, causeId, rotation, quote, f
            ) returns (
                uint256 o
            ) {
                out = o;
                converted = true;
            } catch {
                failure = _returnSelector();
            }
        }
        if (!converted) {
            heldRaw[token][causeId] += f;
            totalHeld[quote] += f;
        }
        emit FeeTaken(token, causeId, rotation, quote, f, out, converted, failure);
    }

    /// @dev The launched token is the side configured here; exactly one side must be.
    function _tokenOf(PoolKey calldata key) internal view returns (address) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool k0 = _tokens[c0].configured;
        bool k1 = _tokens[c1].configured;
        if (k0 && !k1) return c0;
        if (k1 && !k0) return c1;
        revert InvalidPool();
    }

    function _case(PoolKey calldata key, address token, SwapParams calldata params)
        internal
        pure
        returns (SwapCase memory sc)
    {
        sc.quoteIs0 = Currency.unwrap(key.currency0) != token;
        sc.exactIn = params.amountSpecified < 0;
        sc.specifiedIs0 = sc.exactIn == params.zeroForOne;
        sc.specifiedIsQuote = sc.specifiedIs0 == sc.quoteIs0;
    }

    /// @dev Fee of a swap whose specified currency is the quote: out of the input for exact-in
    ///      (zero when it would consume the whole input), on top of the output for exact-out.
    function _specifiedFee(SwapCase memory sc, SwapParams calldata params, uint256 b)
        internal
        pure
        returns (uint256 f)
    {
        uint256 a = _abs(params.amountSpecified);
        if (sc.exactIn) {
            f = FeeScheduleLib.feeOnGross(a, b);
            if (f >= a) f = 0;
        } else {
            f = FeeScheduleLib.feeGrossUp(a, b);
        }
    }

    function _feeBps(TokenState storage t) internal view returns (uint256) {
        return uint256(t.baseFeeBps)
            + FeeScheduleLib.surchargeBps(
            t.launchSurchargeBps, t.surchargeDecaySeconds, t.launchTimestamp, block.timestamp
        );
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    function _lock() internal view returns (uint256 v) {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _setLock(uint256 v) internal {
        bytes32 slot = LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    /// @dev First 4 bytes of the last call's return data, or zero if shorter.
    function _returnSelector() private pure returns (bytes4 sel) {
        assembly ("memory-safe") {
            if gt(returndatasize(), 3) {
                let p := mload(0x40)
                returndatacopy(p, 0, 4)
                sel := and(mload(p), shl(224, 0xffffffff))
            }
        }
    }

    // ------------------------------------------------------------------ unused hooks

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @dev Every donation to a live pool reverts. Support goes to causes through swaps (or
    ///      directly to the cause), never into the locked position.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert DonateNotAllowed();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
