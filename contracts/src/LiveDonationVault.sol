// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";

import {DonationAsset} from "./interfaces/IDonationAsset.sol";
import {ICauseRegistry} from "./interfaces/ICauseRegistry.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {ILiveDonationVault} from "./interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "./interfaces/IRotationGovernor.sol";
import {IEndaomentOrgFundFactory} from "./interfaces/external/IEndaomentOrgFundFactory.sol";
import {IEndaomentRegistry} from "./interfaces/external/IEndaomentRegistry.sol";
import {EndaomentDonateLib} from "./libraries/EndaomentDonateLib.sol";

/// @title LiveDonationVault
/// @notice USDC ledger of live-donation tokens: splits every conversion 10% platform / 90% cause,
///         keeps the cause share per `(token, cause)` and donates it to the cause's Endaoment org.
/// @dev Flow. The live hook converts a swap fee to USDC, has it paid here, then calls
///      `creditLive` with the cause active when the fee was earned. When the bucket's credit
///      reaches the token's threshold (any credit for a zero threshold), the vault pushes it to
///      the org inside the same swap through a gas-capped self call (`executePush`). A push only
///      happens for a deployed, Endaoment-active org; any failure (undeployed or inactive org,
///      address mismatch, paused USDC, out of gas) keeps the credit, sets a one-hour backoff on
///      that bucket and emits `DonationDeferred`, so the swap never reverts. `flush` sends a
///      bucket at any time, deploying the org if needed, ignoring threshold and backoff.
///
///      Credit never moves between causes: a cause rotated out keeps its bucket until flushed.
///      The cause registry's `active` flag is not consulted when paying (as in the distributor);
///      Endaoment's `isActiveEntity` is the gate for deployed orgs.
///
///      Owner powers: `setHook`, once. There is no pause, redirect or rescue to an arbitrary
///      address; `skim` only ever pays the platform treasury and never touches owed USDC.
///
///      Invariants:
///       - V1: `usdc.balanceOf(this) >= platformAccrued + totalPending` and
///         `totalPending == sum of pending[token][cause]` (checked on every credit).
///       - V2: per bucket, credited == pending + donated.
///       - V3: `platform + causeShare == gross`, `platform == floor(gross * 1000 / 10000)`.
///       - V4: each donation sends exactly the debited amount toward the org (Endaoment takes its
///         fee out of it), and leaves no allowance behind.
///
///      Reentrancy: `creditLive`, `flush`, `withdrawPlatform` and `skim` share a transient
///      `nonReentrant` lock, so an org cannot re-enter a vault entry point during a push or flush.
///      `executePush` is self-only and runs inside `creditLive`'s lock. Effects precede the
///      Endaoment calls, allowances are exact and cleared afterwards, and the in-swap push
///      reverts (rolling back the callee) if it changed the pool manager's open delta count or
///      synced currency.
contract LiveDonationVault is ILiveDonationVault, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TransientStateLibrary for IPoolManager;

    /// @notice Platform share of every conversion in basis points (same as the weekly FeeVault).
    uint256 public constant PLATFORM_SHARE_BPS = 1000;
    uint256 internal constant BPS = 10_000;
    /// @notice Highest donation threshold a token may use (1,000,000 USDC).
    uint256 public constant MAX_DONATION_THRESHOLD = 1_000_000e6;
    /// @notice Highest donation threshold of an `Eth` token (1,000 WETH).
    uint256 public constant MAX_DONATION_THRESHOLD_ETH = 1_000e18;
    /// @notice Gas forwarded to an in-swap push (`executePush`).
    /// @dev At least 1.25x the measured push to a deployed org with cold storage (165k against
    ///      the mock org: registry lookup, address check, active check, approve, donate with the
    ///      Endaoment fee, clear, snapshot checks). To be confirmed against mainnet Endaoment on a
    ///      fork before deployment.
    uint256 public constant PUSH_GAS_BUDGET = 220_000;
    /// @notice Gas forwarded to an in-swap push of an `Eth` token: the push plus a WETH to USDC
    ///         conversion through the consolidator. Inside a swap's inline conversion envelope
    ///         this is usually not available and the push is deferred to `flush`.
    uint256 public constant PUSH_GAS_BUDGET_ETH = 600_000;
    /// @notice Gas kept after a push attempt for the backoff write and the event.
    uint256 public constant POST_PUSH_RESERVE = 30_000;
    /// @notice Delay before a bucket whose push failed is pushed inside a swap again.
    uint256 public constant PUSH_BACKOFF = 1 hours;

    /// @inheritdoc ILiveDonationVault
    address public immutable usdc;
    /// @notice WETH, the on-chain form of the `Eth` donation asset (zero: unsupported).
    address public immutable weth;
    /// @notice Converts an `Eth` cause credit into USDC for Endaoment.
    IFeeConsolidator public immutable consolidator;
    /// @notice The factory, the only registrar.
    address public immutable factory;
    /// @notice Receiver of the platform share and of skimmed balances.
    address public immutable platformTreasury;
    ICauseRegistry public immutable causeRegistry;
    IEndaomentOrgFundFactory public immutable endaomentFactory;
    IEndaomentRegistry public immutable endaomentRegistry;
    IRotationGovernor public immutable governor;
    IPoolManager public immutable poolManager;

    /// @notice The live hook, the only account allowed to credit (set once).
    address public hook;

    struct Totals {
        uint128 platformAccrued;
        uint128 totalPending;
    }

    struct TokenConfig {
        bool registered;
        uint96 threshold;
        DonationAsset asset;
    }

    struct Credit {
        uint128 pending;
        uint40 pushRetryAt;
    }

    Totals internal _totals;
    /// @dev Same ledger for the tokens whose donation asset is WETH.
    Totals internal _totalsEth;
    /// @notice Registration and donation threshold of a token.
    mapping(address token => TokenConfig) public configOf;
    mapping(address token => mapping(bytes32 causeId => Credit)) internal _credit;

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    /// @param initialOwner Owner (only power: set the hook once).
    /// @param factory_ The Varada factory (registrar).
    /// @param platformTreasury_ Receiver of the platform share.
    /// @param causeRegistry_ Cause registry (org id and address of a cause).
    /// @param endaomentFactory_ Endaoment OrgFundFactory; its base token is the USDC.
    /// @param governor_ Rotation governor (registered together with the vault).
    /// @param poolManager_ Uniswap v4 pool manager (state snapshot around in-swap pushes).
    /// @param consolidator_ Fee consolidator; its settlement asset must be the same USDC.
    constructor(
        address initialOwner,
        address factory_,
        address platformTreasury_,
        ICauseRegistry causeRegistry_,
        IEndaomentOrgFundFactory endaomentFactory_,
        IRotationGovernor governor_,
        IPoolManager poolManager_,
        IFeeConsolidator consolidator_
    ) Ownable(initialOwner) {
        if (
            factory_ == address(0) || platformTreasury_ == address(0)
                || address(causeRegistry_) == address(0) || address(endaomentFactory_) == address(0)
                || address(governor_) == address(0) || address(poolManager_) == address(0)
                || address(consolidator_) == address(0)
        ) revert ZeroAddress();
        address base = endaomentFactory_.baseToken();
        address registry = endaomentFactory_.registry();
        if (base == address(0) || registry == address(0)) revert ZeroAddress();
        if (consolidator_.settlementAsset() != base) revert SettlementMismatch();
        usdc = base;
        address weth_;
        (bool ok, bytes memory ret) =
            address(consolidator_).staticcall(abi.encodeCall(IFeeConsolidator.weth, ()));
        if (ok && ret.length == 32) weth_ = abi.decode(ret, (address));
        weth = weth_;
        consolidator = consolidator_;
        factory = factory_;
        platformTreasury = platformTreasury_;
        causeRegistry = causeRegistry_;
        endaomentFactory = endaomentFactory_;
        endaomentRegistry = IEndaomentRegistry(registry);
        governor = governor_;
        poolManager = poolManager_;
    }

    // ------------------------------------------------------------------ admin and registration

    /// @notice Sets the live hook. Once.
    function setHook(address hook_) external onlyOwner {
        if (hook != address(0)) revert HookAlreadySet();
        if (hook_ == address(0)) revert ZeroAddress();
        hook = hook_;
        emit HookSet(hook_);
    }

    /// @inheritdoc ILiveDonationVault
    function registerToken(
        address token,
        uint96 threshold,
        bytes32 initialCause,
        RotationPeriod period
    ) external {
        _register(token, threshold, initialCause, period, DonationAsset.Usdc);
    }

    /// @inheritdoc ILiveDonationVault
    function registerToken(
        address token,
        uint96 threshold,
        bytes32 initialCause,
        RotationPeriod period,
        DonationAsset asset
    ) external {
        _register(token, threshold, initialCause, period, asset);
    }

    function _register(
        address token,
        uint96 threshold,
        bytes32 initialCause,
        RotationPeriod period,
        DonationAsset asset
    ) private {
        if (msg.sender != factory) revert NotFactory();
        if (configOf[token].registered) revert AlreadyRegistered(token);
        if (asset == DonationAsset.Eth && weth == address(0)) revert EthUnsupported();
        uint256 max =
            asset == DonationAsset.Eth ? MAX_DONATION_THRESHOLD_ETH : MAX_DONATION_THRESHOLD;
        if (threshold > max) revert ThresholdTooHigh(threshold);
        configOf[token] = TokenConfig({registered: true, threshold: threshold, asset: asset});
        governor.registerToken(token, initialCause, period);
        emit LiveTokenRegistered(token, threshold, initialCause, period, asset);
    }

    /// @inheritdoc ILiveDonationVault
    function donationAssetOf(address token) external view returns (DonationAsset) {
        return configOf[token].asset;
    }

    /// @inheritdoc ILiveDonationVault
    function isRegistered(address token) external view returns (bool) {
        return configOf[token].registered;
    }

    // ------------------------------------------------------------------ crediting and pushing

    /// @inheritdoc ILiveDonationVault
    /// @dev O(1): touches only the `(token, causeId)` bucket. Reverts only for an unregistered
    ///      token or unbacked credit (the hook catches both and holds the fee instead).
    function creditLive(address token, bytes32 causeId, uint64 rotation, uint256 amount)
        external
        nonReentrant
    {
        if (msg.sender != hook) revert NotHook();
        TokenConfig memory cfg = configOf[token];
        if (!cfg.registered) revert TokenNotRegistered(token);

        uint256 platform = (amount * PLATFORM_SHARE_BPS) / BPS;
        uint256 share = amount - platform;
        bool eth = cfg.asset == DonationAsset.Eth;
        Totals memory t = eth ? _totalsEth : _totals;
        t.platformAccrued = SafeCast.toUint128(uint256(t.platformAccrued) + platform);
        t.totalPending = SafeCast.toUint128(uint256(t.totalPending) + share);
        if (eth) _totalsEth = t;
        else _totals = t;
        Credit storage c = _credit[token][causeId];
        uint256 pending = uint256(c.pending) + share;
        c.pending = SafeCast.toUint128(pending);

        uint256 required = uint256(t.platformAccrued) + t.totalPending;
        uint256 balance = IERC20(eth ? weth : usdc).balanceOf(address(this));
        if (balance < required) revert UnbackedCredit(balance, required);
        emit Credited(token, causeId, rotation, amount, platform, share, cfg.asset);

        // Push only when due and not backing off.
        if (cfg.threshold == 0 ? pending == 0 : pending < cfg.threshold) return;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < c.pushRetryAt) return;
        uint256 budget = eth ? PUSH_GAS_BUDGET_ETH : PUSH_GAS_BUDGET;
        if (gasleft() < (budget * 64) / 63 + POST_PUSH_RESERVE) {
            emit DonationDeferred(token, causeId, pending, InsufficientPushGas.selector);
            return;
        }
        try this.executePush{gas: budget}(token, causeId, pending) {}
        catch {
            // Bare catch: only the selector is copied, so return data cannot inflate gas here.
            bytes4 reason = _returnSelector();
            // forge-lint: disable-next-line(unsafe-typecast)
            c.pushRetryAt = uint40(block.timestamp + PUSH_BACKOFF);
            emit DonationDeferred(token, causeId, pending, reason);
        }
    }

    /// @notice In-swap push of `amount` from `(token, causeId)` to the cause's deployed org.
    ///         Self only (from `creditLive`, through a gas-capped try); any revert just defers.
    /// @dev Never deploys an org inside a swap. Reverts `PoolManagerStateChanged` (rolling back
    ///      the callee too) if the Endaoment call left a pool manager delta open or a currency
    ///      synced.
    function executePush(address token, bytes32 causeId, uint256 amount) external onlySelf {
        (bytes32 orgId, address org) = causeRegistry.orgOf(causeId);
        EndaomentDonateLib.checkOrgAddress(endaomentFactory, orgId, org);
        if (org.code.length == 0) revert EndaomentDonateLib.OrgNotDeployed(org);

        uint256 n0 = poolManager.getNonzeroDeltaCount();
        Currency s0 = poolManager.getSyncedCurrency();

        Credit storage c = _credit[token][causeId];
        DonationAsset da = configOf[token].asset;
        c.pending -= SafeCast.toUint128(amount);
        _totalsOf(da).totalPending -= SafeCast.toUint128(amount);

        uint256 usdcAmount = _toUsdc(da, amount);
        EndaomentDonateLib.donateDeployed(IERC20(usdc), endaomentRegistry, org, usdcAmount);

        if (
            poolManager.getNonzeroDeltaCount() != n0
                || Currency.unwrap(poolManager.getSyncedCurrency()) != Currency.unwrap(s0)
        ) revert PoolManagerStateChanged();
        emit Donated(token, causeId, org, amount, false, true, da, usdcAmount);
    }

    /// @inheritdoc ILiveDonationVault
    function flush(address token, bytes32 causeId) external nonReentrant returns (uint256 donated) {
        Credit storage c = _credit[token][causeId];
        donated = c.pending;
        if (donated == 0) revert NothingToFlush(token, causeId);
        (bytes32 orgId, address org) = causeRegistry.orgOf(causeId);
        EndaomentDonateLib.checkOrgAddress(endaomentFactory, orgId, org);

        c.pending = 0;
        c.pushRetryAt = 0;
        DonationAsset da = configOf[token].asset;
        _totalsOf(da).totalPending -= SafeCast.toUint128(donated);

        uint256 usdcAmount = _toUsdc(da, donated);
        bool deploy = org.code.length == 0;
        if (deploy) {
            EndaomentDonateLib.deployAndDonate(
                IERC20(usdc), endaomentFactory, orgId, org, usdcAmount
            );
        } else {
            EndaomentDonateLib.donateDeployed(IERC20(usdc), endaomentRegistry, org, usdcAmount);
        }
        emit Donated(token, causeId, org, donated, deploy, false, da, usdcAmount);
    }

    function _totalsOf(DonationAsset da) private view returns (Totals storage t) {
        return da == DonationAsset.Eth ? _totalsEth : _totals;
    }

    /// @dev Endaoment takes USDC: an `Eth` amount (WETH held here) is converted through the
    ///      consolidator first, with an exact allowance that must be fully used. USDC is
    ///      returned as is. Any failure reverts the whole push or flush, leaving the credit.
    function _toUsdc(DonationAsset da, uint256 amount) private returns (uint256 out) {
        if (da == DonationAsset.Usdc) return amount;
        IERC20(weth).forceApprove(address(consolidator), amount);
        uint256 before = IERC20(usdc).balanceOf(address(this));
        out = consolidator.convertDonation(amount, address(this));
        if (IERC20(usdc).balanceOf(address(this)) - before != out) revert UnbackedCredit(0, out);
        if (IERC20(weth).allowance(address(this), address(consolidator)) != 0) {
            revert EndaomentDonateLib.AllowanceNotCleared(address(consolidator));
        }
    }

    /// @inheritdoc ILiveDonationVault
    /// @dev Pays the accrued share of every asset (USDC, then WETH); returns the USDC amount.
    function withdrawPlatform() external nonReentrant returns (uint256 amount) {
        amount = _totals.platformAccrued;
        uint256 amountEth = _totalsEth.platformAccrued;
        if (amount == 0 && amountEth == 0) revert NothingToWithdraw();
        if (amount != 0) {
            _totals.platformAccrued = 0;
            IERC20(usdc).safeTransfer(platformTreasury, amount);
            emit PlatformWithdrawn(platformTreasury, amount);
        }
        if (amountEth != 0) {
            _totalsEth.platformAccrued = 0;
            IERC20(weth).safeTransfer(platformTreasury, amountEth);
            emit PlatformWithdrawnEth(platformTreasury, amountEth);
        }
    }

    /// @inheritdoc ILiveDonationVault
    function skim(address asset) external nonReentrant returns (uint256 amount) {
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (asset == usdc || (weth != address(0) && asset == weth)) {
            Totals memory t = asset == usdc ? _totals : _totalsEth;
            uint256 owed = uint256(t.platformAccrued) + t.totalPending;
            amount = balance > owed ? balance - owed : 0;
        } else {
            amount = balance;
        }
        if (amount == 0) revert NothingToSkim(asset);
        IERC20(asset).safeTransfer(platformTreasury, amount);
        emit Skimmed(asset, amount);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ILiveDonationVault
    function pendingOf(address token, bytes32 causeId)
        external
        view
        returns (uint256 pending, uint40 pushRetryAt)
    {
        Credit storage c = _credit[token][causeId];
        return (c.pending, c.pushRetryAt);
    }

    /// @inheritdoc ILiveDonationVault
    function platformAccrued() external view returns (uint256) {
        return _totals.platformAccrued;
    }

    /// @inheritdoc ILiveDonationVault
    function totalPending() external view returns (uint256) {
        return _totals.totalPending;
    }

    /// @inheritdoc ILiveDonationVault
    function platformAccruedEth() external view returns (uint256) {
        return _totalsEth.platformAccrued;
    }

    /// @inheritdoc ILiveDonationVault
    function totalPendingEth() external view returns (uint256) {
        return _totalsEth.totalPending;
    }

    /// @notice Donation threshold of `token` (USDC, 6 decimals).
    function thresholdOf(address token) external view returns (uint256) {
        return configOf[token].threshold;
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
}
