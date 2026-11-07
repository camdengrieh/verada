// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {DonationAsset} from "./interfaces/IDonationAsset.sol";
import {IDonationDistributor} from "./interfaces/IDonationDistributor.sol";
import {IEpochGovernor} from "./interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "./interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "./interfaces/IFeeVault.sol";
import {ILpLocker} from "./interfaces/ILpLocker.sol";

/// @title FeeVault
/// @notice Receives fees already consolidated into the settlement asset (USDC), splits them
///         between the platform treasury and a per-token cause pool, and releases each epoch's
///         slice of a token's cause pool to the donation distributor once that epoch has a
///         winner.
/// @dev Only the fee consolidator can deposit, and only the settlement asset. Fees are
///      attributed to the epoch in which they were earned (the consolidator tags every raw
///      amount with its accrual epoch), not to the epoch in which a caller happens to collect,
///      retry or deposit them. Only that epoch's slice can be settled against that epoch's
///      result. Settling an epoch first brings in what is still outstanding for it: the LP
///      locker's fees are collected (they are split by time, so the epoch gets its share) and
///      the consolidator flushes every held balance with a part earned in or before the epoch.
///      If either cannot complete, settlement reverts until `settleGrace` after the epoch's
///      end, so whoever settles cannot push those fees into a later epoch by settling first.
///      Fees that still arrive after their epoch was settled (a route broken past the grace
///      period) go to the first unsettled epoch after it, so they are never stranded.
///      Split math: the platform share is rounded down, so the cause pool always receives the
///      remainder. `platform + cause == amount` exactly for every deposit.
contract FeeVault is IFeeVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @inheritdoc IFeeVault
    uint256 public constant PLATFORM_SHARE_BPS = 1000;

    /// @notice Basis point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @inheritdoc IFeeVault
    uint256 public settleGrace = 7 days;

    /// @notice Shortest and longest `settleGrace`.
    uint256 public constant MIN_SETTLE_GRACE = 5 minutes;
    uint256 public constant MAX_SETTLE_GRACE = 30 days;

    /// @notice `settleGrace` changed.
    event SettleGraceSet(uint256 grace);
    error SettleGraceOutOfRange(uint256 grace, uint256 min, uint256 max);

    error ZeroAddress();
    error NotFactory();
    error AlreadyRegistered(address token);
    error NothingToSettle(address token, uint256 epoch);
    error NothingToWithdraw();
    error ConsolidatorAlreadySet();
    error LpLockerAlreadySet();
    error UnbackedDeposit(uint256 balance, uint256 required);
    error LengthMismatch();
    error EthUnsupported();

    event ConsolidatorSet(address indexed consolidator);
    event LpLockerSet(address indexed lpLocker);

    /// @inheritdoc IFeeVault
    address public immutable settlementAsset;

    /// @notice The factory allowed to register tokens.
    address public immutable factory;

    /// @notice Platform treasury receiving the platform share.
    address public immutable platformTreasury;

    /// @notice Governor consulted for epoch winners.
    IEpochGovernor public immutable governor;

    /// @notice Distributor receiving settled cause pools.
    address public immutable distributor;

    /// @notice The only account allowed to call `depositFees`.
    address public consolidator;

    /// @notice LP locker whose fees are collected before an epoch is settled (zero: none).
    ILpLocker public lpLocker;

    /// @notice Whether a token is registered.
    mapping(address token => bool registered) public isRegistered;

    /// @notice Whether `settle(token, epoch)` has been executed.
    mapping(address token => mapping(uint256 epoch => bool done)) public settled;

    /// @notice Total tracked (platform plus all cause pools) in the settlement asset.
    uint256 public totalTracked;
    /// @notice Total tracked in WETH (tokens whose donation asset is `Eth`).
    uint256 public totalTrackedEth;

    /// @notice WETH, learned from the consolidator when it is set (zero: `Eth` unsupported).
    address public weth;
    /// @dev Donation asset per token (default `Usdc`).
    mapping(address token => DonationAsset asset) private _donationAsset;

    uint256 private _platformAccrued;
    uint256 private _platformAccruedEth;
    /// @dev Unsettled cause pool per token, across all epochs.
    mapping(address token => uint256 amount) private _causePool;
    /// @dev Cause pool attributed to the epoch in which the fees were earned.
    mapping(address token => mapping(uint256 epoch => uint256 amount)) private _epochPool;

    constructor(
        address owner_,
        address factory_,
        address platformTreasury_,
        IEpochGovernor governor_,
        address distributor_,
        address settlementAsset_
    ) Ownable(owner_) {
        if (
            factory_ == address(0) || platformTreasury_ == address(0)
                || address(governor_) == address(0) || distributor_ == address(0)
                || settlementAsset_ == address(0)
        ) revert ZeroAddress();
        factory = factory_;
        platformTreasury = platformTreasury_;
        governor = governor_;
        distributor = distributor_;
        settlementAsset = settlementAsset_;
    }

    /// @notice Sets the fee consolidator (once).
    function setConsolidator(address consolidator_) external onlyOwner {
        if (consolidator_ == address(0)) revert ZeroAddress();
        if (consolidator != address(0)) revert ConsolidatorAlreadySet();
        consolidator = consolidator_;
        // Older consolidators have no `weth()`: `Eth` stays unsupported then.
        (bool ok, bytes memory ret) =
            consolidator_.staticcall(abi.encodeCall(IFeeConsolidator.weth, ()));
        if (ok && ret.length == 32) weth = abi.decode(ret, (address));
        emit ConsolidatorSet(consolidator_);
    }

    /// @notice Sets the LP locker (once).
    function setLpLocker(ILpLocker lpLocker_) external onlyOwner {
        if (address(lpLocker_) == address(0)) revert ZeroAddress();
        if (address(lpLocker) != address(0)) revert LpLockerAlreadySet();
        lpLocker = lpLocker_;
        emit LpLockerSet(address(lpLocker_));
    }

    /// @inheritdoc IFeeVault
    function registerToken(address token) external {
        _register(token, DonationAsset.Usdc);
    }

    /// @inheritdoc IFeeVault
    function registerToken(address token, DonationAsset asset) external {
        _register(token, asset);
    }

    function _register(address token, DonationAsset asset) private {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0)) revert ZeroAddress();
        if (isRegistered[token]) revert AlreadyRegistered(token);
        if (asset == DonationAsset.Eth) {
            if (weth == address(0)) revert EthUnsupported();
            _donationAsset[token] = asset;
        }
        isRegistered[token] = true;
    }

    /// @inheritdoc IFeeVault
    function donationAssetOf(address token) public view returns (DonationAsset) {
        return _donationAsset[token];
    }

    /// @dev The ERC20 a token's pools are held in.
    function _assetOf(address token) private view returns (address) {
        return _donationAsset[token] == DonationAsset.Eth ? weth : settlementAsset;
    }

    /// @notice Pure split of `amount` into platform and cause parts.
    /// @dev The platform part rounds down; the cause pool gets the remainder.
    function split(uint256 amount) public pure returns (uint256 platform, uint256 cause) {
        platform = (amount * PLATFORM_SHARE_BPS) / BPS_DENOMINATOR;
        cause = amount - platform;
    }

    /// @inheritdoc IFeeVault
    function depositFees(
        address token,
        uint256[] calldata accrualEpochs,
        uint256[] calldata amounts
    ) external {
        if (msg.sender != consolidator) revert NotAuthorized();
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        uint256 n = amounts.length;
        if (accrualEpochs.length != n) revert LengthMismatch();

        uint256 current = governor.currentEpoch();
        uint256 platformTotal;
        uint256 causeTotal;
        for (uint256 i; i < n; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            uint256 accrualEpoch = accrualEpochs[i];
            if (accrualEpoch > current) revert FutureEpoch(accrualEpoch, current);
            // A settled epoch cannot take more; the current epoch is never settled (it cannot
            // be finalized before it ends), so the walk always stops.
            uint256 epoch = accrualEpoch;
            while (epoch < current && settled[token][epoch]) {
                ++epoch;
            }
            (uint256 platform, uint256 cause) = split(amount);
            platformTotal += platform;
            causeTotal += cause;
            _epochPool[token][epoch] += cause;
            emit FeesAttributed(token, epoch, accrualEpoch, cause);
        }
        uint256 total = platformTotal + causeTotal;
        if (total == 0) return;

        _causePool[token] += causeTotal;
        address asset = _assetOf(token);
        uint256 tracked;
        if (asset == settlementAsset) {
            _platformAccrued += platformTotal;
            tracked = totalTracked + total;
            totalTracked = tracked;
        } else {
            _platformAccruedEth += platformTotal;
            tracked = totalTrackedEth + total;
            totalTrackedEth = tracked;
        }

        // The funds must already be here; never credit what was not delivered.
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < tracked) revert UnbackedDeposit(balance, tracked);

        emit FeesCollected(token, platformTotal, causeTotal, asset);
    }

    /// @inheritdoc IFeeVault
    function platformAccrued() external view returns (uint256) {
        return _platformAccrued;
    }

    /// @notice Platform share accrued in WETH.
    function platformAccruedEth() external view returns (uint256) {
        return _platformAccruedEth;
    }

    /// @inheritdoc IFeeVault
    /// @dev Total unsettled across all epochs; see `causePoolOf` for a single epoch.
    function causePool(address token) external view returns (uint256) {
        return _causePool[token];
    }

    /// @notice Sets `settleGrace` (`MIN_SETTLE_GRACE..MAX_SETTLE_GRACE`). Owner only. Applies at
    ///         once: it only decides when fees that are still outside the vault stop holding up
    ///         an epoch's settlement (they then go to a later epoch, never stranded).
    function setSettleGrace(uint256 grace) external onlyOwner {
        if (grace < MIN_SETTLE_GRACE || grace > MAX_SETTLE_GRACE) {
            revert SettleGraceOutOfRange(grace, MIN_SETTLE_GRACE, MAX_SETTLE_GRACE);
        }
        settleGrace = grace;
        emit SettleGraceSet(grace);
    }

    /// @notice Cause pool of `token` attributed to `epoch` and not yet settled.
    function causePoolOf(address token, uint256 epoch) external view returns (uint256) {
        return _epochPool[token][epoch];
    }

    /// @inheritdoc IFeeVault
    /// @dev Permissionless. Brings in the epoch's outstanding fees first (see the contract
    ///      notes); the distributor still receives each epoch exactly once.
    function settle(address token, uint256 epoch) external nonReentrant {
        if (!isRegistered[token]) revert TokenNotRegistered(token);
        if (!governor.isFinalized(token, epoch)) revert EpochNotFinalized(token, epoch);
        if (settled[token][epoch]) revert AlreadySettled(token, epoch);

        uint256 end = governor.epochStart(epoch + 1);
        // forge-lint: disable-next-line(block-timestamp)
        if (!_bringIn(token, epoch, end) && block.timestamp < end + settleGrace) {
            revert FeesPending(token, epoch);
        }

        uint256 amount = _epochPool[token][epoch];
        if (amount == 0) revert NothingToSettle(token, epoch);

        _epochPool[token][epoch] = 0;
        _causePool[token] -= amount;
        address asset = _assetOf(token);
        if (asset == settlementAsset) totalTracked -= amount;
        else totalTrackedEth -= amount;
        settled[token][epoch] = true;

        IERC20(asset).safeTransfer(distributor, amount);
        IDonationDistributor(distributor).receiveFunds(token, epoch, amount);
        emit Settled(token, epoch, asset, amount);
    }

    /// @dev Collects the LP fees of `token` if the last collection is older than `end` (the end
    ///      of `epoch`), then has the consolidator flush what it holds from `epoch` or earlier.
    ///      Returns whether nothing earned in `epoch` or earlier is left outside the vault. The
    ///      result is read from state, not from the calls' success, so a caller cannot skip a
    ///      step by starving it of gas or by settling from inside a pool manager unlock.
    function _bringIn(address token, uint256 epoch, uint256 end) private returns (bool clear) {
        clear = true;
        ILpLocker locker = lpLocker;
        if (address(locker) != address(0)) {
            uint256 last = locker.lastCollectedAt(token);
            if (last != 0 && last < end) {
                try locker.collectFees(token) {} catch {}
                clear = locker.lastCollectedAt(token) >= end;
            }
        }
        address cons = consolidator;
        if (cons != address(0)) {
            // A failing consolidator only delays settlement (to the grace period), never
            // strands the epoch.
            try IFeeConsolidator(cons).flushThrough(token, epoch) returns (bool flushed) {
                if (!flushed) clear = false;
            } catch {
                clear = false;
            }
        }
    }

    /// @inheritdoc IFeeVault
    /// @dev Permissionless: funds can only ever go to the platform treasury.
    ///      Pays every asset with an accrued share (USDC, then WETH).
    function withdrawPlatform() external nonReentrant {
        uint256 amount = _platformAccrued;
        uint256 amountEth = _platformAccruedEth;
        if (amount == 0 && amountEth == 0) revert NothingToWithdraw();

        if (amount != 0) {
            _platformAccrued = 0;
            totalTracked -= amount;
            IERC20(settlementAsset).safeTransfer(platformTreasury, amount);
            emit PlatformWithdrawn(settlementAsset, platformTreasury, amount);
        }
        if (amountEth != 0) {
            _platformAccruedEth = 0;
            totalTrackedEth -= amountEth;
            IERC20(weth).safeTransfer(platformTreasury, amountEth);
            emit PlatformWithdrawn(weth, platformTreasury, amountEth);
        }
    }
}
