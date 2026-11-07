// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {IConsolidatorRegistry} from "./FeeConsolidator.sol";
import {PoolInitGateHook} from "./hooks/access/PoolInitGateHook.sol";
import {BaseHook} from "./hooks/base/BaseHook.sol";
import {FeeConversionHook} from "./hooks/conversion/FeeConversionHook.sol";
import {DonationAsset} from "./interfaces/IDonationAsset.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {ILiveDonationVault} from "./interfaces/ILiveDonationVault.sol";
import {IRotationGovernor} from "./interfaces/IRotationGovernor.sol";
import {IVaradaLiveHook} from "./interfaces/IVaradaLiveHook.sol";
import {FeeScheduleLib} from "./libraries/FeeScheduleLib.sol";

/// @dev Registry getter of the fee consolidator (not part of `IFeeConsolidator`).
interface IConsolidatorRoutes {
    function quoteRegistry() external view returns (IConsolidatorRegistry);
}

/// @title VaradaLiveHook
/// @notice Uniswap v4 hook of live-donation tokens: every swap pays a fee in the quote currency,
///         which is converted to USDC inside the same swap and credited to the cause active at
///         that moment. Nothing about the conversion or the donation can revert a trader's swap.
/// @dev Composition. This hook is the generic hooks of `src/hooks` plus Varada glue:
///
///       | Feature                                   | Generic hook                          |
///       | ----------------------------------------- | ------------------------------------- |
///       | callbacks, permission check, shared lock  | `BaseHook`                            |
///       | factory-only pools, quote and token rules | `PoolInitGateHook`                    |
///       | gas floor, in-swap try, hold, retry       | `FeeConversionHook`                   |
///       | quote-side fee on the gross flow          | glue (`_beforeSwap`, `_afterSwap`)    |
///       | conversion through the consolidator       | glue (`_executeConversion`)           |
///       | vault credit to the active cause          | glue (`_onFeeConverted`, `_onFeeHeld`) |
///
///      The fee stays glue rather than `SwapFeeHook` because it is always charged in the quote
///      and on the gross quote flow: when the quote is the specified currency it is taken in
///      `beforeSwap`, and an exact-output fee is grossed up (`feeGrossUp`). `SwapFeeHook` charges
///      the unspecified currency on the net amount. The external ABI is the one of
///      `IVaradaLiveHook` (unchanged); the generic hooks add their own entry points and views
///      (`totalHeld` is `FeeConversionHook.totalHeld`, same selector).
///
///      Fee model. The pool's LP fee is overridden to 0 (the locked position earns nothing). The
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
///      hook's `+f` return delta) and hands them to `FeeConversionHook._convertOrHold` under the
///      bucket `keccak256(token, causeId)`. Unless a currency is synced (a router
///      mid-settlement), a gas-capped self call asks the consolidator to burn those claims and
///      swap them along the quote's hookless registry route under its in-swap price guards
///      (tight deviation and slippage bounds against the route reference, so a route pool pushed
///      before the swap makes the conversion fail and the fee is held rather than sold cheaply),
///      paying USDC to the vault, and credits the vault. If anything fails, the frame is rolled
///      back and the claims stay with the hook as `heldRaw(token, cause)`, attributed to the
///      cause active when they were earned; anyone can `retryHeld` them later.
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
///      Reentrancy. Callbacks are pool-manager only (`BaseHook`). The shared transient lock of
///      `BaseHook` (0 idle, 1 swap, 2 retry) makes a nested swap on any live pool revert
///      `SwapReentered` (so route or vault code cannot re-enter a live pool), lets
///      `unlockCallback` run only for this hook's own retry unlock, and keeps `retryHeld` out of
///      any swap. The swap span is locked here rather than through `_usesSwapLock` so the revert
///      keeps its `SwapReentered` selector. The conversion context (token, cause, rotation) is
///      held in transient storage only while the lock is held, so the bucket-keyed
///      `FeeConversionHook.retryHeld` (which carries no context) always reverts: retries go
///      through `retryHeld(token, causeId, amount)`. Deltas are per caller, so no callee can
///      spend this hook's deltas.
///
///      The hook has no owner. Its address must encode the permission flags (see
///      `getHookPermissions`); mine a salt with the HookMiner library before deploying.
contract VaradaLiveHook is PoolInitGateHook, FeeConversionHook {
    using SafeCast for uint256;
    using TransientStateLibrary for IPoolManager;

    /// @notice `rotation` reported for credits of retried held fees.
    uint64 public constant RETRY_ROTATION = type(uint64).max;

    /// @notice Gas forwarded to the in-swap conversion: up to three route hops including the
    ///         WETH unwrap, the vault credit and a capped push.
    /// @dev Measured with cold storage (test/live/LiveGas.t.sol): `convertClaims` 141k for one
    ///      hop and 302k for three hops with the unwrap, `creditLive` 40k, a push to a deployed
    ///      org 165k. 1.25x the realistic maximum (about 517k) is about 650k, which also covers
    ///      three hops, the credit and a push that burns its whole 220k cap (about 592k).
    uint256 public constant INLINE_GAS_BUDGET = 650_000;
    /// @notice Gas used between the gas check and the try (governor view, mint, synced-currency
    ///         read, call setup); about 33k measured.
    uint256 public constant PRE_TRY_GAS = 40_000;
    /// @notice Gas kept for the hold path after a failed try (two fresh slots, events, return);
    ///         about 50k measured.
    uint256 public constant FALLBACK_RESERVE = 70_000;
    /// @notice Gas required at `afterSwap` when a fee is due (770,317).
    /// @dev The trader's gas limit must leave this much at `afterSwap`. Through the v4 test
    ///      router that is a limit of about 0.86M for a converted swap; the swap itself then uses
    ///      about 0.29M (threshold above the credit) to 0.40M (push in the swap).
    uint256 public constant LIVE_GAS_REQUIRED =
        PRE_TRY_GAS + (INLINE_GAS_BUDGET * 64) / 63 + FALLBACK_RESERVE;

    /// @dev Transient conversion context: slot = token | rotation << 160, slot + 1 = cause.
    bytes32 internal constant CTX_SLOT = bytes32(uint256(keccak256("varada.live.hook.ctx")) - 1);

    /// @notice The factory, the only account allowed to configure tokens and create pools.
    address public immutable factory;
    IFeeConsolidator public immutable consolidator;
    IConsolidatorRegistry public immutable quoteRegistry;
    IRotationGovernor public immutable rotationGovernor;
    ILiveDonationVault internal immutable _vault;
    /// @notice The settlement asset (USDC), also `conversionTarget`.
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

    /// @dev Per-swap case: which side is the quote, and how the fee is taken.
    struct SwapCase {
        bool quoteIs0;
        bool specifiedIs0;
        bool specifiedIsQuote;
        bool exactIn;
    }

    /// @param poolManager_ Uniswap v4 pool manager.
    /// @param factory_ The Varada factory.
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
    )
        BaseHook(_nonZero(poolManager_, factory_, consolidator_, rotationGovernor_, vault_))
        FeeConversionHook(Currency.wrap(
                _settlementOf(poolManager_, factory_, consolidator_, rotationGovernor_, vault_)
            ))
    {
        IConsolidatorRegistry registry = IConsolidatorRoutes(address(consolidator_)).quoteRegistry();
        if (address(registry) == address(0)) revert IVaradaLiveHook.ZeroAddress();

        factory = factory_;
        consolidator = consolidator_;
        quoteRegistry = registry;
        rotationGovernor = rotationGovernor_;
        _vault = vault_;
        usdc = consolidator_.settlementAsset();
        // The consolidator burns this hook's claims when it converts them.
        poolManager_.setOperator(address(consolidator_), true);
    }

    // ------------------------------------------------------------------ configuration

    /// @notice Registers the fee configuration of `token`. Factory only, once.
    function configureToken(address token, IVaradaLiveHook.LiveFeeConfig calldata cfg) external {
        if (msg.sender != factory) revert IVaradaLiveHook.NotFactory();
        TokenState storage t = _tokens[token];
        if (t.configured) revert IVaradaLiveHook.AlreadyConfigured(token);
        FeeScheduleLib.validate(cfg.baseFeeBps, cfg.launchSurchargeBps, cfg.surchargeDecaySeconds);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 launch = cfg.launchTimestamp == 0 ? uint40(block.timestamp) : cfg.launchTimestamp;
        t.baseFeeBps = cfg.baseFeeBps;
        t.launchSurchargeBps = cfg.launchSurchargeBps;
        t.surchargeDecaySeconds = cfg.surchargeDecaySeconds;
        t.launchTimestamp = launch;
        t.configured = true;
        emit IVaradaLiveHook.TokenConfigured(
            token, cfg.baseFeeBps, cfg.launchSurchargeBps, cfg.surchargeDecaySeconds, launch
        );
    }

    // ------------------------------------------------------------------ permissions

    /// @dev Adds the return-delta flags of the quote-side fee and `beforeDonate` (donations are
    ///      refused: they would accrue to the locked position, whose fees the LP locker can never
    ///      forward for a live token). The merged set is `beforeInitialize`, `beforeSwap`,
    ///      `afterSwap`, `beforeDonate`, `beforeSwapReturnDelta`, `afterSwapReturnDelta`.
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(PoolInitGateHook, FeeConversionHook)
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
        p.beforeDonate = true;
        return p;
    }

    /// @dev The swap span is locked in `_beforeSwap` / `_afterSwap` (same slot and states) so a
    ///      nested swap reverts `SwapReentered`.
    function _usesSwapLock() internal pure override(BaseHook, FeeConversionHook) returns (bool) {
        return false;
    }

    // ------------------------------------------------------------------ pool init gate

    /// @dev Only the factory creates live pools. Every rejected pool reverts `InvalidPool`.
    function _isAllowedInitializer(address sender) internal view override returns (bool) {
        if (sender != factory) revert IVaradaLiveHook.InvalidPool();
        return true;
    }

    /// @dev One live pool per configured token, dynamic fee, with an allowed quote that is
    ///      routable to USDC, created after the token was registered with the vault (and so with
    ///      the governor).
    function _validatePoolKey(PoolKey calldata key, uint160) internal view override {
        address token = _tokenOf(key);
        if (
            address(key.hooks) != address(this) || !LPFeeLibrary.isDynamicFee(key.fee)
                || _tokens[token].initialized
        ) revert IVaradaLiveHook.InvalidPool();
        address quote = _quoteOf(key, token);
        if (
            quote == usdc || !quoteRegistry.isAllowed(quote)
                || !quoteRegistry.hasRouteTo(quote, _vault.donationAssetOf(token))
        ) revert IVaradaLiveHook.QuoteNotRoutable(quote);
        if (!_vault.isRegistered(token)) revert IVaradaLiveHook.TokenNotRegistered(token);
    }

    /// @dev Records the pool after the gate accepted it.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(BaseHook, PoolInitGateHook)
        returns (bytes4 selector)
    {
        selector = super._beforeInitialize(sender, key, sqrtPriceX96);
        address token = _tokenOf(key);
        address quote = _quoteOf(key, token);
        TokenState storage t = _tokens[token];
        t.initialized = true;
        t.quote = quote;
        emit IVaradaLiveHook.PoolRegistered(token, quote, PoolId.unwrap(key.toId()));
    }

    // ------------------------------------------------------------------ swap

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override returns (bytes4 selector, BeforeSwapDelta delta, uint24 lpFee) {
        address token = _tokenOf(key);
        if (_hookLockState() != LOCK_IDLE) revert IVaradaLiveHook.SwapReentered();
        _setHookLockState(LOCK_SWAP);
        (selector, delta, lpFee) = super._beforeSwap(sender, key, params, hookData);

        SwapCase memory sc = _case(key, token, params);
        if (sc.specifiedIsQuote) {
            int128 specified = _specifiedFee(sc, params, _feeBps(_tokens[token])).toInt128();
            delta = _addBeforeSwapDelta(delta, toBeforeSwapDelta(specified, 0));
        }
        // LP fee 0.
        lpFee = _mergeLpFeeOverride(lpFee, LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4 selector, int128 hookDelta) {
        (selector, hookDelta) = super._afterSwap(sender, key, params, delta, hookData);
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
                    revert IVaradaLiveHook.PartialFillNotSupported(
                        got >= 0 ? 0 : uint256(uint128(-got)), a - f
                    );
                }
            } else if (got <= 0 || uint256(uint128(got)) != a + f) {
                revert IVaradaLiveHook.PartialFillNotSupported(
                    got <= 0 ? 0 : uint256(uint128(got)), a + f
                );
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
        _setHookLockState(LOCK_IDLE);
        hookDelta += ret.toInt128();
    }

    /// @dev Donations to a live pool always revert. Support goes to causes through swaps (or
    ///      directly to the cause), never into the locked position.
    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert IVaradaLiveHook.DonateNotAllowed();
    }

    // ------------------------------------------------------------------ conversion glue

    /// @dev Records `f` of `quote` as this hook's claims, then converts and credits them or holds
    ///      them for the cause active now. Never reverts for a conversion or donation failure.
    function _takeFee(address token, address quote, uint256 f) private {
        (bytes32 causeId, uint64 rotation) = rotationGovernor.activeCause(token);
        // Hook delta -f now; the pool manager applies the +f return delta after this callback.
        poolManager.mint(address(this), Currency.wrap(quote).toId(), f);

        _setCtx(token, causeId, rotation);
        (bool converted, uint256 out) =
            _convertOrHold(_bucketOf(token, causeId), Currency.wrap(quote), f);
        // A held fee was reported by `_onFeeHeld`.
        if (converted) {
            emit IVaradaLiveHook.FeeTaken(
                token, causeId, rotation, quote, f, out, true, bytes4(0), _vault.donationAssetOf(token)
            );
        }
        _clearCtx();
    }

    /// @dev The consolidator burns this hook's claims (as its ERC-6909 operator) and swaps them
    ///      along the registry route of the quote to USDC, paid to the vault. In a swap it allows
    ///      hookless hops only and applies its in-swap guards.
    function _executeConversion(bytes32, Currency currency, uint256 amount, bool inSwap)
        internal
        override
        returns (uint256)
    {
        (address token,,) = _ctx();
        return consolidator.convertClaimsTo(
            Currency.unwrap(currency),
            amount,
            address(_vault),
            inSwap,
            _vault.donationAssetOf(token)
        );
    }

    /// @dev The consolidator already paid the USDC to the vault.
    function _settleConverted(bytes32, uint256) internal pure override {}

    /// @dev The vault receives every conversion (paid by the consolidator).
    function _conversionRecipient(bytes32) internal view override returns (address) {
        return address(_vault);
    }

    /// @dev Never reached: routes and price guards live in the consolidator, and this hook
    ///      stores no route of its own (`_executeConversion` is overridden).
    function _hopMinOutput(PoolKey memory, bool, uint256, uint160, int24, bool)
        internal
        pure
        override
        returns (uint256)
    {
        revert InvalidRoute();
    }

    /// @dev Credits the converted USDC to the cause of the conversion context.
    function _onFeeConverted(bytes32, Currency, uint256, uint256 out, bool) internal override {
        (address token, bytes32 causeId, uint64 rotation) = _ctx();
        _vault.creditLive(token, causeId, rotation, out);
    }

    /// @dev Reports a held fee with its reason.
    function _onFeeHeld(bytes32, Currency currency, uint256 amount, bytes4 reason)
        internal
        override
    {
        (address token, bytes32 causeId, uint64 rotation) = _ctx();
        emit IVaradaLiveHook.FeeTaken(
            token,
            causeId,
            rotation,
            Currency.unwrap(currency),
            amount,
            0,
            false,
            reason,
            _vault.donationAssetOf(token)
        );
    }

    function _conversionPreTryGas() internal pure override returns (uint256) {
        return PRE_TRY_GAS;
    }

    function _conversionGasBudget() internal pure override returns (uint256) {
        return INLINE_GAS_BUDGET;
    }

    function _conversionFallbackReserve() internal pure override returns (uint256) {
        return FALLBACK_RESERVE;
    }

    /// @dev `afterSwap` checks the full `LIVE_GAS_REQUIRED` before the governor read and the
    ///      mint (which `PRE_TRY_GAS` covers), so the check inside `_convertOrHold` only needs the
    ///      forwarded budget and the fallback reserve.
    function _conversionGasRequired() internal pure override returns (uint256) {
        return LIVE_GAS_REQUIRED - PRE_TRY_GAS;
    }

    /// @notice In-swap conversion step with the bundled hook's arguments. Self only.
    /// @dev Kept for ABI compatibility: the in-swap path enters through
    ///      `FeeConversionHook.convertInline`. Same effect: convert through the consolidator,
    ///      then credit `(token, causeId, rotation)`.
    function inlineConvert(
        address token,
        bytes32 causeId,
        uint64 rotation,
        address quote,
        uint256 amount
    ) external returns (uint256 usdcOut) {
        if (msg.sender != address(this)) revert NotSelf();
        _setCtx(token, causeId, rotation);
        usdcOut = _convert(_bucketOf(token, causeId), Currency.wrap(quote), amount, true);
        _clearCtx();
    }

    /// @notice Converts `amount` of the quote held for `(token, causeId)` into USDC and credits it
    ///         to that cause. Permissionless; outside any pool manager flow. Reverts with the
    ///         route's reason on failure (nothing changes). Chunks are allowed.
    /// @dev Hooked route pools are allowed here (as in the weekly retry); they cannot reach a live
    ///      pool because of the lock.
    function retryHeld(address token, bytes32 causeId, uint256 amount)
        external
        returns (uint256 usdcOut)
    {
        if (_hookLockState() != LOCK_IDLE) revert IVaradaLiveHook.Busy();
        if (poolManager.isUnlocked()) revert PoolManagerBusy();
        if (amount == 0) revert IVaradaLiveHook.NothingHeld();

        _setHookLockState(LOCK_CALL);
        _setCtx(token, causeId, RETRY_ROTATION);
        usdcOut = _retryHeld(_bucketOf(token, causeId), Currency.wrap(_tokens[token].quote), amount);
        _clearCtx();
        _setHookLockState(LOCK_IDLE);
        emit IVaradaLiveHook.HeldRetried(token, causeId, msg.sender, amount, usdcOut);
    }

    /// @notice Pool manager callback of `retryHeld(token, causeId, amount)` only.
    /// @dev Reverts `NotPoolManager` outside this hook's own retry unlock, including the
    ///      bucket-keyed `FeeConversionHook.retryHeld`, which sets no conversion context.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager) || _hookLockState() != LOCK_CALL || !_hasCtx()) {
            revert NotPoolManager();
        }
        (bytes32 bucket, Currency currency, uint256 amount) =
            abi.decode(data, (bytes32, Currency, uint256));
        return abi.encode(_convert(bucket, currency, amount, false));
    }

    // ------------------------------------------------------------------ views

    /// @notice Fee configuration of `token`.
    function feeConfig(address token) external view returns (IVaradaLiveHook.LiveFeeConfig memory) {
        TokenState storage t = _tokens[token];
        return IVaradaLiveHook.LiveFeeConfig(
            t.baseFeeBps, t.launchSurchargeBps, t.surchargeDecaySeconds, t.launchTimestamp
        );
    }

    /// @notice Current fee of `token` in basis points (base plus launch surcharge).
    function currentFeeBps(address token) external view returns (uint24) {
        TokenState storage t = _tokens[token];
        if (!t.configured) revert IVaradaLiveHook.TokenNotConfigured(token);
        // At most 8500, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint24(_feeBps(t));
    }

    /// @notice Quote currency of `token`'s pool (zero before initialization).
    function quoteOf(address token) external view returns (address) {
        return _tokens[token].quote;
    }

    /// @notice Whether `token` has a fee configuration.
    function configured(address token) external view returns (bool) {
        return _tokens[token].configured;
    }

    /// @notice Whether `token`'s pool was initialized.
    function poolInitialized(address token) external view returns (bool) {
        return _tokens[token].initialized;
    }

    /// @notice Quote held unconverted for `(token, causeId)`.
    function heldRaw(address token, bytes32 causeId) external view returns (uint256) {
        return heldFees[_bucketOf(token, causeId)][Currency.wrap(_tokens[token].quote)];
    }

    /// @notice The live-donation vault receiving the USDC.
    function vault() external view returns (address) {
        return address(_vault);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Held-fee bucket of `(token, causeId)`.
    function _bucketOf(address token, bytes32 causeId) internal pure returns (bytes32 bucket) {
        assembly ("memory-safe") {
            mstore(0x00, token)
            mstore(0x20, causeId)
            bucket := keccak256(0x00, 0x40)
        }
    }

    function _setCtx(address token, bytes32 causeId, uint64 rotation) private {
        bytes32 slot = CTX_SLOT;
        assembly ("memory-safe") {
            tstore(
                slot,
                or(and(token, 0xffffffffffffffffffffffffffffffffffffffff), shl(160, rotation))
            )
            tstore(add(slot, 1), causeId)
        }
    }

    function _clearCtx() private {
        bytes32 slot = CTX_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
            tstore(add(slot, 1), 0)
        }
    }

    function _ctx() private view returns (address token, bytes32 causeId, uint64 rotation) {
        bytes32 slot = CTX_SLOT;
        uint256 packed;
        assembly ("memory-safe") {
            packed := tload(slot)
            causeId := tload(add(slot, 1))
        }
        token = address(uint160(packed));
        rotation = uint64(packed >> 160);
    }

    function _hasCtx() private view returns (bool) {
        bytes32 slot = CTX_SLOT;
        uint256 packed;
        assembly ("memory-safe") {
            packed := tload(slot)
        }
        return packed != 0;
    }

    /// @dev Reverts unless every constructor address is set; returns the pool manager.
    function _nonZero(
        IPoolManager poolManager_,
        address factory_,
        IFeeConsolidator consolidator_,
        IRotationGovernor rotationGovernor_,
        ILiveDonationVault vault_
    ) private pure returns (IPoolManager) {
        if (
            address(poolManager_) == address(0) || factory_ == address(0)
                || address(consolidator_) == address(0) || address(rotationGovernor_) == address(0)
                || address(vault_) == address(0)
        ) revert IVaradaLiveHook.ZeroAddress();
        return poolManager_;
    }

    /// @dev The consolidator's settlement asset, which must be the vault's USDC. Checks the
    ///      addresses first (base constructor arguments may be evaluated in either order).
    function _settlementOf(
        IPoolManager poolManager_,
        address factory_,
        IFeeConsolidator consolidator_,
        IRotationGovernor rotationGovernor_,
        ILiveDonationVault vault_
    ) private view returns (address settlement) {
        _nonZero(poolManager_, factory_, consolidator_, rotationGovernor_, vault_);
        settlement = consolidator_.settlementAsset();
        if (settlement == address(0) || vault_.usdc() != settlement) {
            revert IVaradaLiveHook.SettlementMismatch();
        }
    }

    /// @dev The launched token is the side configured here; exactly one side must be.
    function _tokenOf(PoolKey calldata key) internal view returns (address) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool k0 = _tokens[c0].configured;
        bool k1 = _tokens[c1].configured;
        if (k0 && !k1) return c0;
        if (k1 && !k0) return c1;
        revert IVaradaLiveHook.InvalidPool();
    }

    function _quoteOf(PoolKey calldata key, address token) internal pure returns (address) {
        address c0 = Currency.unwrap(key.currency0);
        return c0 == token ? Currency.unwrap(key.currency1) : c0;
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
}
