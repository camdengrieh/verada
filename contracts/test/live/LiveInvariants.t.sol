// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VeradaLiveHook} from "../../src/VeradaLiveHook.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockEndaomentRegistry} from "../mocks/EndaomentMocks.sol";
import {MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";
import {LiveBase} from "./LiveBase.sol";
import {AdversarialOrg, LiveUSDC, SyncingRouter} from "./LiveMocks.sol";

/// @dev Everything the handler needs, passed from the fixture in one struct.
struct LiveWorld {
    IPoolManager manager;
    PoolSwapTest swapRouter;
    SyncingRouter syncRouter;
    VeradaLiveHook hook;
    LiveDonationVault vault;
    RotationGovernor gov;
    MockVotingScheme scheme;
    CatalogFixture cat;
    FeeConsolidator cons;
    LiveUSDC usdc;
    MockEndaomentRegistry endRegistry;
    AdversarialOrg orgA;
    PoolKey routeKey;
    address quote;
    address weth;
    address owner;
}

/// @dev Traders, chaos (USDC pause, consolidator source, references, org behaviour), keepers
///      (rotation polls, retries, flushes, platform withdrawals) and time, with ghost accounting
///      of every fee, hold, credit and donation.
contract LiveHandler is Test {
    using PoolIdLibrary for PoolKey;

    LiveWorld internal w;
    VeradaToken[] internal tokens;
    PoolKey[] internal keys;
    address[] internal quotes;
    bytes32[] internal causeIds;
    address public trader;
    address public voter;

    // ---- ghosts
    mapping(address token => uint256) public feeTaken;
    mapping(address token => uint256) public convertedIn;
    mapping(address token => uint256) public heldIn;
    mapping(address token => uint256) public retriedIn;
    mapping(address token => mapping(bytes32 cause => uint256)) public credited;
    mapping(address token => mapping(bytes32 cause => uint256)) public donated;
    uint256 public unexpectedTraderReverts;
    uint256 public wrongCause;
    uint256 public swaps;
    uint256 public holds;
    uint256 public pushes;
    uint256 public retries;
    uint256 public flushes;
    uint256 public applied;

    constructor(
        LiveWorld memory world,
        VeradaToken[] memory tokens_,
        PoolKey[] memory keys_,
        address[] memory quotes_,
        bytes32[] memory causes_,
        address trader_,
        address voter_
    ) {
        w = world;
        for (uint256 i; i < tokens_.length; ++i) {
            tokens.push(tokens_[i]);
            keys.push(keys_[i]);
            quotes.push(quotes_[i]);
        }
        causeIds = causes_;
        trader = trader_;
        voter = voter_;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function tokenAt(uint256 i) external view returns (address) {
        return address(tokens[i]);
    }

    function quoteAt(uint256 i) external view returns (address) {
        return quotes[i];
    }

    function causeAt(uint256 i) external view returns (bytes32) {
        return causeIds[i];
    }

    function causeCount() external view returns (uint256) {
        return causeIds.length;
    }

    // ---- log accounting

    function _account(Vm.Log[] memory logs, address token, bytes32 expectedCause) internal {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            if (l.emitter == address(w.hook) && t0 == IVeradaLiveHook.FeeTaken.selector) {
                (, uint256 f,, bool converted,) =
                    abi.decode(l.data, (address, uint256, uint256, bool, bytes4));
                feeTaken[token] += f;
                if (converted) {
                    convertedIn[token] += f;
                } else {
                    heldIn[token] += f;
                    ++holds;
                }
                if (l.topics[2] != expectedCause) ++wrongCause;
            } else if (l.emitter == address(w.vault) && t0 == ILiveDonationVault.Credited.selector)
            {
                (,, uint256 share) = abi.decode(l.data, (uint256, uint256, uint256));
                credited[address(uint160(uint256(l.topics[1])))][l.topics[2]] += share;
            } else if (l.emitter == address(w.vault) && t0 == ILiveDonationVault.Donated.selector) {
                (uint256 amount,, bool inSwap) = abi.decode(l.data, (uint256, bool, bool));
                donated[address(uint160(uint256(l.topics[1])))][l.topics[2]] += amount;
                if (inSwap) ++pushes;
            }
        }
    }

    // ---- traders

    function trade(uint8 tokenSeed, uint8 kind, uint256 size, bool viaSyncingRouter) external {
        uint256 i = tokenSeed % tokens.length;
        PoolKey memory key = keys[i];
        address token = address(tokens[i]);
        bool quoteIs0 = Currency.unwrap(key.currency0) != token;
        kind = kind % 4;
        bool buy = kind < 2;
        bool exactIn = kind % 2 == 0;
        bool specifiedIsQuote = buy == exactIn;
        uint256 amount = specifiedIsQuote ? bound(size, 1e14, 3e18) : bound(size, 1e17, 3e21);
        bool zeroForOne = buy ? quoteIs0 : !quoteIs0;
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: exactIn ? -int256(amount) : int256(amount),
            sqrtPriceLimitX96: zeroForOne
                ? TickMath.MIN_SQRT_PRICE + 1
                : TickMath.MAX_SQRT_PRICE - 1
        });
        (bytes32 cause,) = w.gov.activeCause(token);

        vm.recordLogs();
        vm.prank(trader);
        bool ok;
        if (viaSyncingRouter && buy && exactIn) {
            try w.syncRouter.swap(key, p, Currency.wrap(address(w.usdc))) {
                ok = true;
            } catch {}
        } else {
            try w.swapRouter
                .swap(
                    key,
                    p,
                    PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                    ""
                ) {
                ok = true;
            } catch {}
        }
        if (!ok) {
            ++unexpectedTraderReverts;
            return;
        }
        ++swaps;
        _account(vm.getRecordedLogs(), token, cause);
    }

    // ---- chaos

    function chaosUsdcPause(bool paused) external {
        w.usdc.setPaused(paused);
    }

    function chaosSource(bool allowed) external {
        vm.prank(w.owner);
        w.cons.setSource(address(w.hook), allowed);
    }

    function chaosReference(int16 offset) external {
        (, int24 spot,,) = StateLibrary.getSlot0(w.manager, w.routeKey.toId());
        vm.prank(w.owner);
        w.cons.setReference(w.routeKey, spot + int24(offset) % 3000);
    }

    function chaosOrgMode(uint8 mode) external {
        AdversarialOrg.Mode m = AdversarialOrg.Mode(mode % 4); // normal, revert, burn, bomb
        w.orgA.configure(m, address(0), address(0), bytes32(0));
    }

    function chaosOrgActive(bool active) external {
        w.endRegistry.setActive(address(w.orgA), active);
    }

    // ---- keepers

    function retry(uint8 tokenSeed, uint8 causeSeed, uint256 fraction) external {
        address token = address(tokens[tokenSeed % tokens.length]);
        bytes32 cause = causeIds[causeSeed % causeIds.length];
        uint256 held = w.hook.heldRaw(token, cause);
        if (held == 0) return;
        uint256 amount = bound(fraction, 1, held);
        vm.recordLogs();
        try w.hook.retryHeld(token, cause, amount) {
            retriedIn[token] += amount;
            ++retries;
            _account(vm.getRecordedLogs(), token, cause);
        } catch {}
    }

    function flush(uint8 tokenSeed, uint8 causeSeed) external {
        address token = address(tokens[tokenSeed % tokens.length]);
        bytes32 cause = causeIds[causeSeed % causeIds.length];
        vm.recordLogs();
        try w.vault.flush(token, cause) {
            ++flushes;
            _account(vm.getRecordedLogs(), token, cause);
        } catch {}
    }

    function withdrawPlatform() external {
        try w.vault.withdrawPlatform() {} catch {}
    }

    /// @dev Prepares `token`'s round `target` as a keeper would, if nobody did.
    function _prepareRound(address token, uint64 target) internal {
        (IRotationGovernor.RoundStatus st,,,,,,) = w.gov.roundOf(token, target);
        if (st != IRotationGovernor.RoundStatus.None) return;
        (uint64 c, uint16 r) = w.gov.profileRegistry().focusOf(token);
        try w.cat
        .draws(IEpochGovernor(address(w.gov)), w.gov.causeRegistry(), token, target, c, r) returns (
            IEpochGovernor.Draw[] memory d
        ) {
            try w.gov.prepareRound(token, target, d) {} catch {}
        } catch {}
    }

    function rotate(uint8 tokenSeed, uint8 choice, bool late) external {
        address token = address(tokens[tokenSeed % tokens.length]);
        uint64 target = w.gov.currentRotation(token) + 1;
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
        _prepareRound(token, target);
        vm.prank(voter);
        try w.scheme.castBallot(address(w.gov), token, scope, abi.encode(uint8(choice % 3))) {}
        catch {
            return;
        }
        (,, uint40 voteEnd,,,,) = w.gov.roundOf(token, target);
        if (block.timestamp < voteEnd) vm.warp(voteEnd);
        w.gov.closeRound(token, target);
        w.scheme.finalizeFromBallots(address(w.gov), token, scope);
        if (late) vm.warp(w.gov.rotationStart(token, target) + 20 minutes);
        w.gov.finalizeRound(token, target);
        (IRotationGovernor.RoundStatus st,,,,,,) = w.gov.roundOf(token, target);
        if (st == IRotationGovernor.RoundStatus.Applied) ++applied;
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(uint256(by), 1, 3 hours));
    }
}

contract LiveInvariantsTest is LiveBase {
    LiveHandler internal handler;
    address internal voter = makeAddr("voter");
    bytes32[] internal causeList;

    function setUp() public {
        _liveSetUp();
        (VeradaToken tq, PoolKey memory kq) =
            _launch(address(quote), 0, RotationPeriod.OneHour, 0, 0);
        (VeradaToken tw, PoolKey memory kw) =
            _launch(address(weth), 5e6, RotationPeriod.OneHour, 2000, 600);
        _fundTrader(trader, tq);
        tw.transfer(trader, 1e27);
        vm.prank(trader);
        tw.approve(address(swapRouter), type(uint256).max);
        tq.transfer(voter, 1e26);
        tw.transfer(voter, 1e26);

        SyncingRouter syncRouter = new SyncingRouter(manager);
        vm.startPrank(trader);
        quote.approve(address(syncRouter), type(uint256).max);
        weth.approve(address(syncRouter), type(uint256).max);
        vm.stopPrank();
        AdversarialOrg org = _makeAdversarial(orgA);

        VeradaToken[] memory ts = new VeradaToken[](2);
        ts[0] = tq;
        ts[1] = tw;
        PoolKey[] memory ks = new PoolKey[](2);
        ks[0] = kq;
        ks[1] = kw;
        address[] memory qs = new address[](2);
        qs[0] = address(quote);
        qs[1] = address(weth);
        causeList.push(CAUSE_A);
        causeList.push(CAUSE_B);
        causeList.push(CAUSE_C);

        LiveWorld memory world = LiveWorld({
            manager: manager,
            swapRouter: swapRouter,
            syncRouter: syncRouter,
            hook: hook,
            vault: vault,
            gov: rgov,
            scheme: scheme,
            cat: cat,
            cons: cons,
            usdc: usdc,
            endRegistry: endRegistry,
            orgA: org,
            routeKey: quoteUsdcKey,
            quote: address(quote),
            weth: address(weth),
            owner: address(this)
        });
        handler = new LiveHandler(world, ts, ks, qs, causeList, trader, voter);
        // Rotation 25 onwards: the voter's checkpoint predates every hold window (one day
        // before each poll snapshot).
        vm.warp(block.timestamp + 1 days + 1 hours + 1);
        targetContract(address(handler));
    }

    function _sumHeld(address q) internal view returns (uint256 sum) {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            if (handler.quoteAt(i) != q) continue;
            for (uint256 c; c < causeList.length; ++c) {
                sum += hook.heldRaw(handler.tokenAt(i), causeList[c]);
            }
        }
    }

    /// H1: the hook's claims back exactly what it holds, per quote currency.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 100
    function invariant_H1_claimsBackHolds() public view {
        address[2] memory qs = [address(quote), address(weth)];
        for (uint256 i; i < 2; ++i) {
            assertEq(_claims(address(hook), qs[i]), hook.totalHeld(Currency.wrap(qs[i])));
            assertEq(hook.totalHeld(Currency.wrap(qs[i])), _sumHeld(qs[i]));
        }
    }

    /// H2: every fee is converted or held; holds only shrink by what retries burned.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 100
    function invariant_H2_feesConvertedOrHeld() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokenAt(i);
            assertEq(handler.feeTaken(t), handler.convertedIn(t) + handler.heldIn(t));
            uint256 held;
            for (uint256 c; c < causeList.length; ++c) {
                held += hook.heldRaw(t, causeList[c]);
            }
            assertEq(held, handler.heldIn(t) - handler.retriedIn(t));
        }
    }

    /// H4/G3: no trader swap reverted, and every fee went to the cause active at the swap.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 100
    function invariant_H4_tradersNeverRevert() public view {
        assertEq(handler.unexpectedTraderReverts(), 0);
        assertEq(handler.wrongCause(), 0);
    }

    /// V1/V2: the vault is backed, and per bucket credited == pending + donated.
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 100
    function invariant_V1_V2_vaultLedger() public view {
        uint256 sumPending;
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokenAt(i);
            for (uint256 c; c < causeList.length; ++c) {
                (uint256 pending,) = vault.pendingOf(t, causeList[c]);
                sumPending += pending;
                assertEq(
                    handler.credited(t, causeList[c]), pending + handler.donated(t, causeList[c])
                );
            }
        }
        assertEq(vault.totalPending(), sumPending);
        assertGe(usdc.balanceOf(address(vault)), vault.platformAccrued() + vault.totalPending());
    }

    /// @dev Smoke test: one pass through every handler path.
    function test_handlerReachesEveryPath() public {
        handler.trade(0, 0, 1e18, false); // converted, pushed (threshold 0)
        handler.trade(1, 0, 1e17, false); // WETH, accrues
        handler.trade(0, 0, 1e18, true); // syncing router: held
        handler.chaosSource(false);
        handler.trade(0, 2, 1e20, false); // held
        handler.chaosSource(true);
        handler.retry(0, 0, type(uint256).max);
        handler.chaosOrgActive(false);
        handler.trade(0, 1, 1e20, false); // converted, push deferred
        handler.chaosOrgActive(true);
        handler.flush(0, 0);
        handler.rotate(0, 2, false);
        handler.warp(1 hours);
        handler.trade(0, 3, 1e16, false); // cause C now
        handler.withdrawPlatform();
        assertGt(handler.swaps(), 0);
        assertGt(handler.holds(), 0);
        assertGt(handler.pushes(), 0);
        assertGt(handler.retries(), 0);
        assertGt(handler.flushes(), 0);
        assertGt(handler.applied(), 0);
        invariant_H1_claimsBackHolds();
        invariant_H2_feesConvertedOrHeld();
        invariant_H4_tradersNeverRevert();
        invariant_V1_V2_vaultLedger();
    }
}
