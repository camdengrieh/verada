// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
import {VaradaLiveHook} from "../../src/VaradaLiveHook.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaLiveHook} from "../../src/interfaces/IVaradaLiveHook.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockEndaomentRegistry} from "../mocks/EndaomentMocks.sol";
import {MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";
import {LiveFactoryBase} from "./LiveFactoryBase.sol";
import {AdversarialOrg} from "./LiveMocks.sol";

/// @dev Everything the handler needs from the fixture.
struct FactoryWorld {
    IPoolManager manager;
    PoolSwapTest swapRouter;
    VaradaLiveHook hook;
    LiveDonationVault vault;
    RotationGovernor gov;
    MockVotingScheme scheme;
    CatalogFixture cat;
    FeeConsolidator cons;
    MockEndaomentRegistry endRegistry;
    AdversarialOrg orgA;
    PoolKey quoteRoute;
    PoolKey wethRoute;
    address owner;
}

/// @dev Drives factory-launched live tokens: trades of every kind by the handler itself, route
///      and org chaos, keepers (retries, flushes, platform withdrawals), holders voting rotation
///      rounds and period changes, and time. Ghosts record every fee, conversion, hold, credit,
///      donation and withdrawal from the emitted events, and every (rotation, cause) pair observed.
contract LiveFactoryHandler is Test {
    using PoolIdLibrary for PoolKey;

    FactoryWorld internal w;
    address[] internal tokens;
    PoolKey[] internal keys;
    bytes32[] internal causeIds;
    address[] internal voters;

    // ---- ghosts: accounting
    mapping(address token => uint64) public pendingProposal;
    mapping(address token => uint256) public feeTaken;
    mapping(address token => uint256) public convertedIn;
    mapping(address token => uint256) public heldIn;
    mapping(address token => uint256) public retriedIn;
    mapping(address token => mapping(bytes32 cause => uint256)) public creditedShare;
    mapping(address token => mapping(bytes32 cause => uint256)) public donated;
    uint256 public usdcConverted;
    uint256 public creditedGross;
    uint256 public creditedPlatform;
    uint256 public platformWithdrawn;
    uint256 public splitErrors;

    // ---- ghosts: rotations
    mapping(address token => mapping(bytes32 cause => bool)) public allowedCause;
    mapping(address token => mapping(uint64 rotation => bytes32)) internal _observed;
    mapping(address token => mapping(uint64 rotation => bool)) internal _seen;
    mapping(address token => uint64) public lastRotation;
    mapping(address token => uint64[]) internal _votedTargets;
    uint256 public wrongAttribution;
    uint256 public rotationRegressions;
    uint256 public causeRewrites;
    uint256 public foreignCauses;
    uint256 public unexpectedReverts;
    bytes public lastRevert;

    // ---- coverage
    uint256 public swaps;
    uint256 public holds;
    uint256 public pushes;
    uint256 public deferrals;
    uint256 public retries;
    uint256 public flushes;
    uint256 public applied;
    uint256 public periodChanges;

    constructor(
        FactoryWorld memory world,
        address[] memory tokens_,
        PoolKey[] memory keys_,
        bytes32[] memory causes_,
        address[] memory voters_,
        bytes32[] memory initialCauses
    ) {
        w = world;
        for (uint256 i; i < tokens_.length; ++i) {
            tokens.push(tokens_[i]);
            keys.push(keys_[i]);
            allowedCause[tokens_[i]][initialCauses[i]] = true;
        }
        causeIds = causes_;
        voters = voters_;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function tokenAt(uint256 i) external view returns (address) {
        return tokens[i];
    }

    function quoteOfToken(uint256 i) external view returns (address) {
        return w.hook.quoteOf(tokens[i]);
    }

    /// @dev Approves the router for the handler's own trades (called once by the fixture).
    function approveAll(address[] calldata assets) external {
        for (uint256 i; i < assets.length; ++i) {
            IERC20(assets[i]).approve(address(w.swapRouter), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ ghost updates

    function _observe() internal {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            (bytes32 cause, uint64 rotation) = w.gov.activeCause(t);
            if (rotation < lastRotation[t]) ++rotationRegressions;
            lastRotation[t] = rotation;
            if (_seen[t][rotation]) {
                if (_observed[t][rotation] != cause) ++causeRewrites;
            } else {
                _seen[t][rotation] = true;
                _observed[t][rotation] = cause;
            }
            if (!allowedCause[t][cause]) ++foreignCauses;
        }
    }

    modifier observed() {
        _observe();
        _;
        _observe();
    }

    function _account(Vm.Log[] memory logs, bytes32 expectedCause, uint64 expectedRotation)
        internal
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0) continue;
            bytes32 t0 = l.topics[0];
            address token =
                address(uint160(uint256(l.topics.length > 1 ? l.topics[1] : bytes32(0))));
            if (l.emitter == address(w.hook) && t0 == IVaradaLiveHook.FeeTaken.selector) {
                (, uint256 f, uint256 out, bool converted,) =
                    abi.decode(l.data, (address, uint256, uint256, bool, bytes4));
                feeTaken[token] += f;
                if (converted) {
                    convertedIn[token] += f;
                    usdcConverted += out;
                } else {
                    heldIn[token] += f;
                    ++holds;
                }
                if (
                    l.topics[2] != expectedCause || uint64(uint256(l.topics[3])) != expectedRotation
                ) {
                    ++wrongAttribution;
                }
            } else if (l.emitter == address(w.hook) && t0 == IVaradaLiveHook.HeldRetried.selector) {
                (uint256 quoteIn, uint256 out) = abi.decode(l.data, (uint256, uint256));
                retriedIn[token] += quoteIn;
                usdcConverted += out;
            } else if (l.emitter == address(w.vault) && t0 == ILiveDonationVault.Credited.selector)
            {
                (uint256 gross, uint256 platform, uint256 share) =
                    abi.decode(l.data, (uint256, uint256, uint256));
                if (platform != (gross * 1000) / 10_000 || platform + share != gross) {
                    ++splitErrors;
                }
                creditedGross += gross;
                creditedPlatform += platform;
                creditedShare[token][l.topics[2]] += share;
            } else if (l.emitter == address(w.vault) && t0 == ILiveDonationVault.Donated.selector) {
                (uint256 amount,, bool inSwap) = abi.decode(l.data, (uint256, bool, bool));
                donated[token][l.topics[2]] += amount;
                if (inSwap) ++pushes;
            } else if (
                l.emitter == address(w.vault) && t0 == ILiveDonationVault.DonationDeferred.selector
            ) {
                ++deferrals;
            }
        }
    }

    // ------------------------------------------------------------------ traders

    function trade(uint8 tokenSeed, uint8 kind, uint256 size) external observed {
        _trade(address(this), tokenSeed, kind, size, true);
    }

    /// @dev Fixture-only (not a fuzz target): a buy by `who`, accounted like any trade.
    function seedBuy(address who, uint8 tokenSeed, uint256 quoteIn) external observed {
        _trade(who, tokenSeed, 0, quoteIn, false);
    }

    function _trade(address who, uint8 tokenSeed, uint8 kind, uint256 size, bool bounded) internal {
        uint256 i = tokenSeed % tokens.length;
        PoolKey memory key = keys[i];
        address token = tokens[i];
        bool quoteIs0 = Currency.unwrap(key.currency0) != token;
        kind = kind % 4;
        // Sells need a stock of the token; below it the handler buys instead.
        if (kind >= 2 && IERC20(token).balanceOf(who) < 1e22) kind = kind - 2;
        bool buy = kind < 2;
        bool exactIn = kind % 2 == 0;
        bool specifiedIsQuote = buy == exactIn;
        uint256 amount =
            !bounded ? size : specifiedIsQuote ? bound(size, 1e14, 3e18) : bound(size, 1e17, 3e21);
        bool zeroForOne = buy ? quoteIs0 : !quoteIs0;
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: exactIn ? -int256(amount) : int256(amount),
            sqrtPriceLimitX96: zeroForOne
                ? TickMath.MIN_SQRT_PRICE + 1
                : TickMath.MAX_SQRT_PRICE - 1
        });
        (bytes32 cause, uint64 rotation) = w.gov.activeCause(token);

        vm.recordLogs();
        vm.prank(who);
        try w.swapRouter
            .swap(
                key, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), ""
            ) {
            ++swaps;
            _account(vm.getRecordedLogs(), cause, rotation);
        } catch (bytes memory err) {
            ++unexpectedReverts;
            lastRevert = err;
        }
    }

    // ------------------------------------------------------------------ chaos

    function chaosReference(bool wethRoute, int16 offset) external observed {
        PoolKey memory key = wethRoute ? w.wethRoute : w.quoteRoute;
        (, int24 spot,,) = StateLibrary.getSlot0(w.manager, key.toId());
        vm.prank(w.owner);
        w.cons.setReference(key, spot + int24(offset) % 3000);
    }

    function chaosOrgMode(uint8 mode) external observed {
        w.orgA.configure(AdversarialOrg.Mode(mode % 4), address(0), address(0), bytes32(0));
    }

    function chaosOrgActive(bool active) external observed {
        w.endRegistry.setActive(address(w.orgA), active);
    }

    // ------------------------------------------------------------------ keepers

    /// @dev The first cause from `causeSeed` on with a hold (or pending credit) for `token`.
    function _causeWith(address token, uint8 causeSeed, bool held)
        internal
        view
        returns (bytes32 cause, uint256 amount)
    {
        for (uint256 k; k < causeIds.length; ++k) {
            cause = causeIds[(uint256(causeSeed) + k) % causeIds.length];
            if (held) amount = w.hook.heldRaw(token, cause);
            else (amount,) = w.vault.pendingOf(token, cause);
            if (amount != 0) return (cause, amount);
        }
    }

    function retry(uint8 tokenSeed, uint8 causeSeed, uint256 amountSeed) external observed {
        address token = tokens[tokenSeed % tokens.length];
        (bytes32 cause, uint256 held) = _causeWith(token, causeSeed, true);
        if (held == 0) return;
        uint256 amount = bound(amountSeed, 1, held);
        vm.recordLogs();
        try w.hook.retryHeld(token, cause, amount) {
            ++retries;
            _account(vm.getRecordedLogs(), bytes32(0), 0);
        } catch {}
    }

    function flush(uint8 tokenSeed, uint8 causeSeed) external observed {
        address token = tokens[tokenSeed % tokens.length];
        (bytes32 cause,) = _causeWith(token, causeSeed, false);
        vm.recordLogs();
        try w.vault.flush(token, cause) {
            ++flushes;
            _account(vm.getRecordedLogs(), bytes32(0), 0);
        } catch {}
    }

    function withdrawPlatform() external observed {
        try w.vault.withdrawPlatform() returns (uint256 amount) {
            platformWithdrawn += amount;
        } catch {}
    }

    function warp(uint32 by) external observed {
        vm.warp(block.timestamp + bound(uint256(by), 1, 1 hours));
    }

    // ------------------------------------------------------------------ holders

    function vote(uint8 tokenSeed, uint8 voterSeed, uint8 choice) external observed {
        address token = tokens[tokenSeed % tokens.length];
        uint64 target = w.gov.currentRotation(token) + 1;
        _prepareRound(token, target);
        vm.prank(voters[voterSeed % voters.length]);
        try w.scheme
            .castBallot(
                address(w.gov),
                token,
                PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target),
                abi.encode(uint8(choice % 3))
            ) {
            if (_votedTargets[token].length == 0 || _lastVoted(token) != target) {
                _votedTargets[token].push(target);
            }
        } catch {}
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

    function _lastVoted(address token) internal view returns (uint64) {
        return _votedTargets[token][_votedTargets[token].length - 1];
    }

    /// @dev Closes, tallies and finalizes every voted round that is due. A round finalized after
    ///      its target started is a late result (it applies from the next boundary); one older
    ///      than an applied target is recorded as stale.
    function settleRounds(uint8 tokenSeed) external observed {
        address token = tokens[tokenSeed % tokens.length];
        uint64[] storage targets = _votedTargets[token];
        for (uint256 k = targets.length; k > 0; --k) {
            uint64 target = targets[k - 1];
            (IRotationGovernor.RoundStatus before,, uint40 voteEnd,,,,) =
                w.gov.roundOf(token, target);
            if (before > IRotationGovernor.RoundStatus.Closed || block.timestamp < voteEnd) {
                continue;
            }
            try w.gov.closeRound(token, target) {} catch {}
            try w.scheme
                .finalizeFromBallots(
                    address(w.gov), token, PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target)
                ) {}
                catch {}
            try w.gov.finalizeRound(token, target) {
                (IRotationGovernor.RoundStatus st,,,, bytes32 winner,,) =
                    w.gov.roundOf(token, target);
                if (st == IRotationGovernor.RoundStatus.Applied) {
                    allowedCause[token][winner] = true;
                    ++applied;
                }
            } catch {}
        }
    }

    /// @dev Proposes a period change (and votes FOR with two holders), or advances the pending
    ///      proposal: close, tally, execute.
    function periodChange(uint8 tokenSeed, uint8 periodSeed) external observed {
        address token = tokens[tokenSeed % tokens.length];
        uint64 id = pendingProposal[token];
        if (id != 0) {
            IRotationGovernor.ProposalState st = w.gov.proposalState(id);
            if (
                st != IRotationGovernor.ProposalState.Active
                    && st != IRotationGovernor.ProposalState.Ended
                    && st != IRotationGovernor.ProposalState.Closed
            ) id = 0;
        }
        if (id == 0) {
            vm.prank(voters[0]);
            try w.gov.proposePeriod(token, RotationPeriod(periodSeed % 5)) returns (uint64 newId) {
                pendingProposal[token] = newId;
                uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_PERIOD, newId);
                for (uint256 v; v < 2; ++v) {
                    vm.prank(voters[v]);
                    try w.scheme.castBallot(address(w.gov), token, scope, abi.encode(uint8(1))) {}
                        catch {}
                }
            } catch {}
            return;
        }
        try w.gov.closePeriodProposal(id) {} catch {}
        try w.scheme
            .finalizeFromBallots(
                address(w.gov), token, PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id)
            ) {}
            catch {}
        try w.gov.executePeriodProposal(id) returns (bool executed) {
            if (executed) ++periodChanges;
        } catch {}
    }
}

/// @dev Handler-based invariants over tokens launched through the factory: credit conservation
///      (every converted USDC is credited, split 10/90, and is either pending, donated or
///      withdrawn) and rotation consistency (every fee goes to the cause active at the swap, the
///      cause of a rotation never changes once it started, rotation indices never go back, and
///      the active cause is always the initial cause or an applied winner).
contract LiveFactoryInvariantsTest is LiveFactoryBase {
    LiveFactoryHandler internal handler;
    address internal carol = makeAddr("carol");
    bytes32[] internal causeList;

    function setUp() public {
        _factorySetUp();
        // Short proposals so period changes happen within a run.
        rgov.setParams(
            IRotationGovernor.Params({
                votingPeriod: 1 hours,
                executionWindow: 1 days,
                cooldown: 0,
                quorumBps: 1000,
                proposalThresholdBps: 50
            })
        );

        (VaradaToken tq, PoolKey memory kq) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        (VaradaToken tw, PoolKey memory kw) =
            _launchLive(address(weth), 5e6, RotationPeriod.OneHour, CAUSE_C);

        AdversarialOrg org = _makeAdversarial(orgA);

        address[] memory ts = new address[](2);
        ts[0] = address(tq);
        ts[1] = address(tw);
        PoolKey[] memory ks = new PoolKey[](2);
        ks[0] = kq;
        ks[1] = kw;
        causeList.push(CAUSE_A);
        causeList.push(CAUSE_B);
        causeList.push(CAUSE_C);
        address[] memory vs = new address[](3);
        vs[0] = alice;
        vs[1] = bob;
        vs[2] = carol;
        bytes32[] memory initial = new bytes32[](2);
        initial[0] = CAUSE_A;
        initial[1] = CAUSE_C;

        handler = new LiveFactoryHandler(
            FactoryWorld({
                manager: manager,
                swapRouter: swapRouter,
                hook: hook,
                vault: vault,
                gov: rgov,
                scheme: scheme,
                cat: cat,
                cons: cons,
                endRegistry: endRegistry,
                orgA: org,
                quoteRoute: quoteUsdcKey,
                wethRoute: ethUsdcKey,
                owner: address(this)
            }),
            ts,
            ks,
            causeList,
            vs,
            initial
        );

        // The handler trades as itself: quote, WETH and a stock of both tokens to sell.
        quote.mint(address(handler), 1e27);
        vm.deal(address(handler), 1e24);
        vm.prank(address(handler));
        weth.deposit{value: 1e23}();
        address[] memory assets = new address[](4);
        assets[0] = address(quote);
        assets[1] = address(weth);
        assets[2] = address(tq);
        assets[3] = address(tw);
        handler.approveAll(assets);
        handler.seedBuy(address(handler), 0, 1e20);
        handler.seedBuy(address(handler), 1, 3e19);

        // Three holders buy in rotation 0; they vote once their hold windows cover it.
        address[3] memory holders = [alice, bob, carol];
        uint256[3] memory sizes = [uint256(5e20), 2e20, 5e19];
        for (uint256 h; h < 3; ++h) {
            _fund(holders[h], tq);
            vm.prank(holders[h]);
            tw.approve(address(swapRouter), type(uint256).max);
            handler.seedBuy(holders[h], 0, sizes[h]);
            handler.seedBuy(holders[h], 1, sizes[h] / 30);
        }

        // Rotation 25: the holders' checkpoints predate every hold window (one day before each
        // poll snapshot) from here on.
        vm.warp(block.timestamp + 1 days + 1 hours + 1);
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = LiveFactoryHandler.trade.selector;
        selectors[1] = LiveFactoryHandler.trade.selector; // trades weigh double
        selectors[2] = LiveFactoryHandler.chaosReference.selector;
        selectors[3] = LiveFactoryHandler.chaosOrgMode.selector;
        selectors[4] = LiveFactoryHandler.chaosOrgActive.selector;
        selectors[5] = LiveFactoryHandler.retry.selector;
        selectors[6] = LiveFactoryHandler.flush.selector;
        selectors[7] = LiveFactoryHandler.withdrawPlatform.selector;
        selectors[8] = LiveFactoryHandler.warp.selector;
        selectors[9] = LiveFactoryHandler.vote.selector;
        selectors[10] = LiveFactoryHandler.settleRounds.selector;
        selectors[11] = LiveFactoryHandler.periodChange.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _sumHeld(address token) internal view returns (uint256 sum) {
        for (uint256 c; c < causeList.length; ++c) {
            sum += hook.heldRaw(token, causeList[c]);
        }
    }

    /// Credit conservation: per bucket credited == pending + donated, the ledger totals match,
    /// the platform share is accrued or withdrawn, the vault holds exactly what it owes, every
    /// credit is a 10/90 split, and every converted USDC was credited.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_creditConservation() public view {
        uint256 sumPending;
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokenAt(i);
            for (uint256 c; c < causeList.length; ++c) {
                (uint256 pending,) = vault.pendingOf(t, causeList[c]);
                sumPending += pending;
                assertEq(
                    handler.creditedShare(t, causeList[c]),
                    pending + handler.donated(t, causeList[c]),
                    "bucket"
                );
            }
        }
        assertEq(vault.totalPending(), sumPending, "total pending");
        assertEq(
            handler.creditedPlatform(),
            vault.platformAccrued() + handler.platformWithdrawn(),
            "platform"
        );
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.platformAccrued() + vault.totalPending(),
            "backing"
        );
        assertEq(handler.splitErrors(), 0, "split");
        assertEq(handler.usdcConverted(), handler.creditedGross(), "converted == credited");
    }

    /// Holds: claims back exactly what is held, every fee is converted or held, and holds only
    /// shrink by what retries burned.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_holdsBacked() public view {
        address[2] memory qs = [address(quote), address(weth)];
        for (uint256 q; q < 2; ++q) {
            uint256 sum;
            for (uint256 i; i < handler.tokenCount(); ++i) {
                if (handler.quoteOfToken(i) == qs[q]) sum += _sumHeld(handler.tokenAt(i));
            }
            assertEq(_claims(address(hook), qs[q]), hook.totalHeld(Currency.wrap(qs[q])), "claims");
            assertEq(hook.totalHeld(Currency.wrap(qs[q])), sum, "total held");
        }
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokenAt(i);
            assertEq(handler.feeTaken(t), handler.convertedIn(t) + handler.heldIn(t), "fees");
            assertEq(_sumHeld(t), handler.heldIn(t) - handler.retriedIn(t), "held");
        }
    }

    /// Rotation consistency.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_rotationConsistency() public view {
        assertEq(handler.wrongAttribution(), 0, "fee attributed to the active cause");
        assertEq(handler.rotationRegressions(), 0, "rotation index never goes back");
        assertEq(handler.causeRewrites(), 0, "cause of a started rotation is fixed");
        assertEq(handler.foreignCauses(), 0, "initial cause or an applied winner");
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokenAt(i);
            uint64 cur = rgov.currentRotation(t);
            assertLe(rgov.rotationStart(t, cur), block.timestamp, "started");
            assertGt(rgov.rotationStart(t, cur + 1), block.timestamp, "not ended");
            (bytes32 cause,) = rgov.activeCause(t);
            assertEq(rgov.activeCauseAt(t, block.timestamp), cause, "views agree");
        }
    }

    /// No trader swap ever reverts.
    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 60
    function invariant_tradersNeverRevert() public view {
        assertEq(handler.unexpectedReverts(), 0, vm.toString(handler.lastRevert()));
    }

    /// @dev Smoke test: one pass through every handler path, then all invariants.
    function test_handlerReachesEveryPath() public {
        handler.trade(0, 0, 1e18); // converted, pushed (threshold 0)
        handler.trade(1, 0, 1e17); // WETH, accrues
        handler.trade(0, 2, 1e20); // sell exact-in
        handler.trade(1, 3, 1e16); // sell exact-out
        handler.chaosReference(false, 2500);
        handler.trade(0, 1, 1e20); // held
        handler.chaosReference(false, 0);
        handler.retry(0, 0, type(uint256).max);
        handler.chaosOrgMode(1);
        handler.trade(0, 0, 1e18); // push deferred
        handler.chaosOrgMode(0);
        handler.flush(0, 0);
        handler.vote(0, 0, 1);
        handler.warp(1 hours);
        handler.settleRounds(0);
        handler.warp(1 hours);
        handler.trade(0, 0, 1e18); // cause B now
        handler.periodChange(0, 2); // propose OneDay, vote
        handler.warp(1 hours);
        handler.periodChange(0, 2); // close, tally, execute
        handler.warp(3 hours);
        handler.trade(0, 0, 1e18);
        handler.withdrawPlatform();
        assertGt(handler.swaps(), 0, "swaps");
        assertGt(handler.holds(), 0, "holds");
        assertGt(handler.pushes(), 0, "pushes");
        assertGt(handler.deferrals(), 0, "deferrals");
        assertGt(handler.retries(), 0, "retries");
        assertGt(handler.flushes(), 0, "flushes");
        assertGt(handler.applied(), 0, "applied");
        assertGt(handler.periodChanges(), 0, "period changes");
        assertGt(handler.platformWithdrawn(), 0, "withdrawn");
        invariant_creditConservation();
        invariant_holdsBacked();
        invariant_rotationConsistency();
        invariant_tradersNeverRevert();
    }
}
