// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {PoolAdminHook} from "../base/PoolAdminHook.sol";

/// @title BondingCurveHook
/// @notice REFERENCE IMPLEMENTATION ONLY. It is not used in production and has not been audited.
///         It shows how a v4 hook can replace a pool's concentrated liquidity with its own
///         pricing curve ("custom curve" / NoOp pattern) and stop trading at a graduation
///         threshold.
/// @notice One side of each pool is the curve token, the other the quote. The price follows a
///         virtual constant product `(virtualQuote + quoteReserve) * tokenReserve = k`. The hook
///         holds both reserves as ERC-6909 claims on the pool manager and settles every swap by
///         minting claims of the input currency and burning claims of the output currency, so no
///         token moves and no external code runs inside a swap. Its `beforeSwap` delta consumes
///         the whole specified amount, so the pool's own liquidity (there is none: adding it is
///         blocked) is never touched.
/// @dev Lifecycle per pool: only an initializer the owner allows (`PoolInitGateHook`, for
///      example a launch factory) may call `PoolManager.initialize`, and it becomes the pool
///      admin. The admin calls `configureCurve` once, `seed`s the curve with tokens before the
///      first buy, and after graduation withdraws both reserves as claims with
///      `withdrawAfterGraduation`. Swaps are exact-input only. Output rounds down, so `k` never
///      decreases and a round trip never profits.
///      Example limitations (fix them before any real use):
///      - After graduation every swap reverts `CurveGraduated`, sells included. Holders have no
///        market until the admin moves the reserves somewhere they can trade.
///      - `withdrawAfterGraduation` sends all raised quote and the unsold tokens to any address
///        the admin picks. The admin is trusted with the buyers' quote: make it a migrator
///        contract that puts both reserves into a locked pool in the same transaction.
///      Composition: the curve must be the only feature of a concrete hook that returns a
///      `beforeSwap` delta (it consumes the full specified amount, so any other delta would make
///      the pool manager revert `HookDeltaExceedsSwapAmount`). Its callbacks call `super` first
///      and are `virtual`, so it can be inherited next to other features. hookData is unused.
contract BondingCurveHook is PoolInitGateHook, PoolAdminHook, Ownable, IUnlockCallback {
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    /// @notice State of one pool's curve.
    /// @param tokenIs0 Whether the curve token is currency0 (the quote is then currency1).
    /// @param virtualQuote Virtual quote reserve that sets the starting price; never paid out.
    /// @param tokenReserve Curve tokens held by the hook as claims.
    /// @param quoteReserve Quote raised by the curve and held by the hook as claims.
    /// @param graduationQuote Quote reserve at which the curve stops trading.
    /// @param graduated Whether the curve has graduated (trading closed, reserves withdrawable).
    struct Curve {
        bool tokenIs0;
        uint128 virtualQuote;
        uint128 tokenReserve;
        uint128 quoteReserve;
        uint128 graduationQuote;
        bool graduated;
    }

    /// @notice Curve of each pool (all zero until configured).
    mapping(PoolId => Curve) public curves;

    /// @notice The pool admin configured the curve of `poolId`.
    event CurveConfigured(
        PoolId indexed poolId, bool tokenIs0, uint128 virtualQuote, uint128 graduationQuote
    );
    /// @notice `amount` curve tokens were added to the token reserve of `poolId`.
    event CurveSeeded(PoolId indexed poolId, uint256 amount);
    /// @notice A swap on the curve: `buy` is quote in / token out, otherwise token in / quote out.
    ///         `sender` is the caller of `PoolManager.swap` (usually a router).
    event CurveSwap(
        PoolId indexed poolId, address indexed sender, bool buy, uint256 amountIn, uint256 amountOut
    );
    /// @notice The curve of `poolId` reached its graduation threshold with `quoteRaised`.
    event Graduated(PoolId indexed poolId, uint256 quoteRaised);
    /// @notice The admin withdrew the reserves of a graduated curve as claims to `to`.
    event CurveWithdrawn(
        PoolId indexed poolId, address indexed to, uint256 tokenAmount, uint256 quoteAmount
    );

    /// @notice Exact-output swaps are not supported by the curve.
    error ExactOutputNotSupported();
    /// @notice The curve has graduated; trading is closed.
    error CurveGraduated();
    /// @notice The curve has not graduated yet.
    error CurveNotGraduated();
    /// @notice Liquidity cannot be added to a curve pool.
    error CurveLiquidityDisabled();
    /// @notice The curve is not configured or not seeded.
    error CurveNotReady();
    /// @notice The output of a swap exceeds the reserve that pays it.
    error InsufficientReserve();
    /// @notice The curve of this pool is already configured.
    error CurveAlreadyConfigured();
    /// @notice Invalid curve parameters (zero virtual quote or threshold, native curve token).
    error InvalidCurve();
    /// @notice Seeding is closed (the curve has been bought from) or the amount is zero.
    error SeedingClosed();
    /// @notice The recipient is the zero address.
    error InvalidRecipient();
    /// @notice `unlockCallback` was not started by this hook's own `seed`.
    error UnexpectedCallback();

    /// @param poolManager_ The v4 pool manager.
    /// @param owner_ The account that may allow and disallow pool initializers.
    constructor(IPoolManager poolManager_, address owner_) BaseHook(poolManager_) Ownable(owner_) {}

    // ------------------------------------------------------------------ admin

    /// @notice Allows or disallows `account` to initialize pools with this hook (and so to
    ///         become their pool admin). Only the owner; existing pools keep their admin.
    /// @param account The initializer (normally a launch factory).
    /// @param allowed Whether `account` may call `PoolManager.initialize` for this hook.
    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    /// @notice Sets the curve of `key`'s pool. Callable once, by the pool admin.
    /// @param key The pool (its hook must be this contract).
    /// @param tokenIs0 Whether currency0 is the curve token (it must not be native).
    /// @param virtualQuote Virtual quote reserve (> 0); the starting price is
    ///        `virtualQuote / tokenReserve` quote per token.
    /// @param graduationQuote Quote reserve (> 0) at which trading closes.
    function configureCurve(
        PoolKey calldata key,
        bool tokenIs0,
        uint128 virtualQuote,
        uint128 graduationQuote
    ) external virtual onlyPoolAdmin(key) {
        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (c.virtualQuote != 0) revert CurveAlreadyConfigured();
        Currency token = tokenIs0 ? key.currency0 : key.currency1;
        if (virtualQuote == 0 || graduationQuote == 0 || token.isAddressZero()) {
            revert InvalidCurve();
        }
        c.tokenIs0 = tokenIs0;
        c.virtualQuote = virtualQuote;
        c.graduationQuote = graduationQuote;
        emit CurveConfigured(id, tokenIs0, virtualQuote, graduationQuote);
    }

    /// @notice Pulls `tokenAmount` curve tokens from the pool admin (who must have approved this
    ///         hook) into the pool manager and credits them to the token reserve as claims.
    /// @dev Allowed until the first buy (`quoteReserve == 0`): adding tokens later would lower the
    ///      price under existing holders. The credited amount is what the pool manager received,
    ///      so a token that takes a transfer fee credits less.
    /// @param key The pool.
    /// @param tokenAmount Tokens to pull (> 0).
    function seed(PoolKey calldata key, uint256 tokenAmount)
        external
        virtual
        onlyPoolAdmin(key)
        hookNonReentrant
    {
        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (c.virtualQuote == 0) revert CurveNotReady();
        if (c.graduated) revert CurveGraduated();
        if (c.quoteReserve != 0 || tokenAmount == 0) revert SeedingClosed();
        Currency token = c.tokenIs0 ? key.currency0 : key.currency1;
        uint256 paid =
            abi.decode(poolManager.unlock(abi.encode(token, msg.sender, tokenAmount)), (uint256));
        c.tokenReserve = (uint256(c.tokenReserve) + paid).toUint128();
        emit CurveSeeded(id, paid);
    }

    /// @notice Sends both reserves of a graduated curve to `to` as ERC-6909 claims on the pool
    ///         manager (redeem them with `unlock` + `burn` + `take`). Pool admin only.
    /// @dev The admin receives every unit of quote the buyers paid; nothing here makes it
    ///      provide a market afterwards (see the contract notes).
    /// @param key The pool.
    /// @param to Recipient of the claims (not zero).
    function withdrawAfterGraduation(PoolKey calldata key, address to)
        external
        virtual
        onlyPoolAdmin(key)
    {
        if (to == address(0)) revert InvalidRecipient();
        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (!c.graduated) revert CurveNotGraduated();
        uint256 tokenAmount = c.tokenReserve;
        uint256 quoteAmount = c.quoteReserve;
        c.tokenReserve = 0;
        c.quoteReserve = 0;
        (Currency token, Currency quote) = _currencies(key, c.tokenIs0);
        if (tokenAmount != 0) poolManager.transfer(to, token.toId(), tokenAmount);
        if (quoteAmount != 0) poolManager.transfer(to, quote.toId(), quoteAmount);
        emit CurveWithdrawn(id, to, tokenAmount, quoteAmount);
    }

    /// @notice Settles a `seed`: pulls the tokens into the pool manager and mints the claims.
    /// @dev Pool manager only, and only inside this hook's own `seed` (lock held in `LOCK_CALL`).
    /// @param data `abi.encode(Currency token, address payer, uint256 amount)`.
    /// @return `abi.encode(uint256 paid)`, the amount the pool manager received.
    function unlockCallback(bytes calldata data) external virtual returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (_hookLockState() != LOCK_CALL) revert UnexpectedCallback();
        (Currency token, address payer, uint256 amount) =
            abi.decode(data, (Currency, address, uint256));
        poolManager.sync(token);
        IERC20(Currency.unwrap(token)).safeTransferFrom(payer, address(poolManager), amount);
        uint256 paid = poolManager.settle();
        poolManager.mint(address(this), token.toId(), paid);
        return abi.encode(paid);
    }

    // ------------------------------------------------------------------ views

    /// @notice Curve tokens out for `quoteIn` quote in, at the current state (0 when not ready).
    /// @param poolId The pool.
    /// @param quoteIn Quote paid in.
    /// @return tokenOut `floor(tokenReserve * quoteIn / (virtualQuote + quoteReserve + quoteIn))`.
    function quoteBuy(PoolId poolId, uint256 quoteIn) public view returns (uint256 tokenOut) {
        Curve storage c = curves[poolId];
        if (c.virtualQuote == 0) return 0;
        return _buyOut(c, quoteIn);
    }

    /// @notice Quote out for `tokenIn` curve tokens in, at the current state (0 when not ready).
    ///         May exceed `quoteReserve`, in which case the swap reverts `InsufficientReserve`.
    /// @param poolId The pool.
    /// @param tokenIn Curve tokens paid in.
    /// @return quoteOut `floor((virtualQuote + quoteReserve) * tokenIn / (tokenReserve + tokenIn))`.
    function quoteSell(PoolId poolId, uint256 tokenIn) public view returns (uint256 quoteOut) {
        Curve storage c = curves[poolId];
        if (c.virtualQuote == 0) return 0;
        return _sellOut(c, tokenIn);
    }

    // ------------------------------------------------------------------ hook

    /// @dev The caller of `PoolManager.initialize` passed the init gate, so it is the admin.
    function _initialPoolAdmin(address sender, PoolKey calldata)
        internal
        view
        virtual
        override
        returns (address)
    {
        return sender;
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override(PoolInitGateHook, PoolAdminHook)
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
        return p;
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override(PoolInitGateHook, PoolAdminHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4) {
        super._beforeAddLiquidity(sender, key, params, hookData);
        revert CurveLiquidityDisabled();
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector, BeforeSwapDelta delta, uint24 fee) {
        (selector, delta, fee) = super._beforeSwap(sender, key, params, hookData);
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (c.virtualQuote == 0 || c.tokenReserve == 0) revert CurveNotReady();
        if (c.graduated) revert CurveGraduated();

        uint256 amountIn = uint256(-params.amountSpecified);
        int128 specified = amountIn.toInt128();
        bool buy = params.zeroForOne != c.tokenIs0; // input is the quote
        uint256 amountOut;
        if (buy) {
            amountOut = _buyOut(c, amountIn);
            if (amountOut > c.tokenReserve) revert InsufficientReserve();
            c.quoteReserve = (uint256(c.quoteReserve) + amountIn).toUint128();
            c.tokenReserve -= uint128(amountOut);
        } else {
            amountOut = _sellOut(c, amountIn);
            if (amountOut > c.quoteReserve) revert InsufficientReserve();
            c.tokenReserve = (uint256(c.tokenReserve) + amountIn).toUint128();
            c.quoteReserve -= uint128(amountOut);
        }

        // Exact input: the specified currency is the input. The hook is credited the input (+)
        // and owes the output (-); minting / burning its own claims nets both to zero.
        (Currency input, Currency output) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        poolManager.mint(address(this), input.toId(), amountIn);
        if (amountOut != 0) poolManager.burn(address(this), output.toId(), amountOut);

        delta = _addBeforeSwapDelta(delta, toBeforeSwapDelta(specified, -amountOut.toInt128()));
        emit CurveSwap(id, sender, buy, amountIn, amountOut);

        if (buy && c.quoteReserve >= c.graduationQuote) {
            c.graduated = true;
            emit Graduated(id, c.quoteReserve);
        }
    }

    // ------------------------------------------------------------------ math

    function _buyOut(Curve storage c, uint256 quoteIn) internal view returns (uint256) {
        uint256 x = uint256(c.virtualQuote) + c.quoteReserve;
        return FullMath.mulDiv(c.tokenReserve, quoteIn, x + quoteIn);
    }

    function _sellOut(Curve storage c, uint256 tokenIn) internal view returns (uint256) {
        uint256 x = uint256(c.virtualQuote) + c.quoteReserve;
        uint256 y = c.tokenReserve;
        if (y + tokenIn == 0) return 0;
        return FullMath.mulDiv(x, tokenIn, y + tokenIn);
    }

    function _currencies(PoolKey calldata key, bool tokenIs0)
        internal
        pure
        returns (Currency token, Currency quote)
    {
        (token, quote) = tokenIs0 ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
    }
}
