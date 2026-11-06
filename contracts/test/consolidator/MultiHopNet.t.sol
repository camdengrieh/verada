// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVaradaHook} from "../../src/interfaces/IVaradaHook.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";
import {MockERC20} from "./ConsolidatorMocks.sol";

/// @dev Fixture with a two hop quote route (quote -> mid -> USDC), the shape a V3 hop adds to
///      (a route longer than one pool, mixed pool types). Shared by the multi hop invariants and
///      the hostile token tests.
abstract contract MultiHopFixture is ConsolidatorBase {
    using PoolIdLibrary for PoolKey;

    MockERC20 internal mid;
    PoolKey internal quoteMidKey; // quote / mid, 0.3%
    PoolKey internal midUsdcKey; // mid / usdc, 0.3%

    function _initPool(address a, address b, uint24 fee, address base, address priceIn, int24 abs_, int256 L)
        internal
        returns (PoolKey memory key)
    {
        (Currency c0, Currency c1) = _sorted(a, b);
        key = PoolKey(c0, c1, fee, 60, IHooks(address(0)));
        int24 tick = _orientedTick(base, priceIn, abs_);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        _addLiquidity(key, tick, L);
    }

    function _hostSetUp() internal {
        _baseSetUp();
        mid = new MockERC20("MID", 18);
        mid.mint(address(this), 1e36);
        mid.approve(address(modifyLiquidityRouter), type(uint256).max);
        mid.approve(address(swapRouter), type(uint256).max);

        quoteMidKey = _initPool(address(quote), address(mid), 3000, address(quote), address(mid), 0, 2e21);
        midUsdcKey = _initPool(address(mid), address(usdc), 3000, address(mid), address(usdc), QUOTE_TICK, 2e19);

        PoolKey[] memory route = new PoolKey[](2);
        route[0] = quoteMidKey;
        route[1] = midUsdcKey;
        registry.addQuoteAssetWithRoute(address(quote), IQuoteRegistry.Kind.Ondo, route);
        cons.seedReferences(route);
        _launch(meme, address(quote));
        skip(2000);
    }

    /// @dev Configures `token` on the hook and opens its hooked pool against `quoteAsset`.
    function _launch(MockERC20 token, address quoteAsset) internal returns (PoolKey memory key) {
        hook.configureToken(
            address(token),
            IVaradaHook.FeeConfig({
                baseFeeBps: BASE_BPS,
                sniperFeeStartBps: 3000,
                sniperDecaySeconds: 1 days,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        (Currency t0, Currency t1) = _sorted(address(token), quoteAsset);
        key = PoolKey(t0, t1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        int24 tt = _orientedTick(address(token), quoteAsset, TOKEN_TICK);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tt));
        _addLiquidity(key, tt, 1e24);
        tokenKey = key;
    }

    /// @dev Output of `amount` at the price of `tick`, before fees and impact.
    function _atTick(uint256 amount, int24 tick, bool zeroForOne) internal pure returns (uint256) {
        uint160 s = TickMath.getSqrtPriceAtTick(tick);
        return zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amount, s, 1 << 96), s, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, s), 1 << 96, s);
    }

    function _refTick(PoolKey memory k) internal view returns (int24 t_) {
        (t_,,,,) = cons.references(k.toId());
    }

    /// @dev Lowest USDC the two hop route may return for `amount` quote: each hop at least
    ///      `reference * (1 - slippage - hop fee)`, with the references as they were before.
    function _floorOut(uint256 amount) internal view returns (uint256) {
        uint256 tol = MAX_SLIPPAGE_BPS + 30; // 0.3% pool fee = 30 bps
        bool z1 = address(quote) < address(mid);
        bool z2 = address(mid) < address(usdc);
        uint256 b1 = _atTick(amount, _refTick(quoteMidKey), z1) * (10_000 - tol) / 10_000;
        return _atTick(b1, _refTick(midUsdcKey), z2) * (10_000 - tol) / 10_000;
    }
}

/// @dev Random deliveries, retries, pauses, trades, flash-style price pushes and time travel over
///      a two hop route. Properties: no residual balance of the quote, the intermediate asset or
///      USDC in the consolidator, no dangling approvals, every successful conversion honours the
///      per hop minimum, held accounting is conserved, the vault stays backed.
contract MultiHopNetTest is MultiHopFixture {
    uint256 internal deliveredQuote;
    uint256 internal badFills;
    uint256 internal successes;
    uint256 internal lastTracked;
    uint256 internal trackedDrops;
    uint256 internal minted;

    function setUp() public {
        _hostSetUp();
        targetContract(address(this));
        bytes4[] memory s = new bytes4[](8);
        s[0] = this.h_deliver.selector;
        s[1] = this.h_retry.selector;
        s[2] = this.h_retryPartial.selector;
        s[3] = this.h_push.selector;
        s[4] = this.h_warp.selector;
        s[5] = this.h_pause.selector;
        s[6] = this.h_reseed.selector;
        s[7] = this.h_flush.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: s}));
    }

    function _track() internal {
        uint256 t = vault.totalTracked();
        if (t < lastTracked) trackedDrops++;
        lastTracked = t;
    }

    /// Delivers quote when nothing is held, so the whole conversion is the single swap whose
    /// floor can be checked from the references read just before.
    function h_deliver(uint96 amountRaw) external {
        uint256 amount = (uint256(amountRaw) % 5e21) + 1e12;
        quote.mint(address(cons), amount);
        uint256 heldBefore = cons.heldFees(address(meme), address(quote));
        uint256 floor = heldBefore == 0 ? _floorOut(amount) : 0;
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), amount);
        uint256 got = usdc.balanceOf(address(vault)) - vaultBefore;
        if (heldBefore == 0 && cons.heldFees(address(meme), address(quote)) == 0 && got != 0) {
            successes++;
            if (got < floor) badFills++;
        }
        _track();
    }

    function h_retry() external {
        try cons.retry(address(meme), address(quote)) {} catch {}
        _track();
    }

    function h_retryPartial(uint96 amount) external {
        uint256 held = cons.heldFees(address(meme), address(quote));
        if (held != 0) {
            try cons.retryAmount(address(meme), address(quote), (uint256(amount) % held) + 1) {}
            catch {}
        }
        _track();
    }

    /// Pushes one of the route pools by a random amount (a sandwich leg or organic trade).
    function h_push(bool firstPool, bool dir, uint96 amount) external {
        PoolKey memory k = firstPool ? quoteMidKey : midUsdcKey;
        uint256 a = (uint256(amount) % (firstPool ? 5e22 : 3e22)) + 1e6;
        try this.trade(k, dir, a) {} catch {}
    }

    function trade(PoolKey calldata k, bool zeroForOne, uint256 a) external {
        require(msg.sender == address(this));
        swap(k, zeroForOne, -int256(a), ZERO_BYTES);
    }

    function h_warp(uint32 secs) external {
        skip(uint256(secs) % 3 hours);
    }

    function h_pause(bool p) external {
        quote.setPaused(p);
    }

    function h_reseed() external {
        PoolKey[] memory ks = new PoolKey[](2);
        ks[0] = quoteMidKey;
        ks[1] = midUsdcKey;
        cons.seedReferences(ks);
    }

    function h_flush() external {
        cons.flushThrough(address(meme), 0);
        _track();
    }

    // ------------------------------------------------------------------ invariants

    /// No residual balance of any route asset: the quote is exactly what is held, the
    /// intermediate asset, USDC, WETH and ETH are zero.
    function invariant_noResiduals() public view {
        assertEq(quote.balanceOf(address(cons)), cons.totalHeld(address(quote)), "quote");
        assertEq(meme.balanceOf(address(cons)), cons.totalHeld(address(meme)), "meme");
        assertEq(mid.balanceOf(address(cons)), 0, "mid");
        assertEq(usdc.balanceOf(address(cons)), 0, "usdc");
        assertEq(weth.balanceOf(address(cons)), 0, "weth");
        assertEq(address(cons).balance, 0, "eth");
        assertEq(mid.balanceOf(address(hook)), 0);
        assertEq(quote.balanceOf(address(hook)), 0);
    }

    /// Nothing is ever approved to the pool manager, the vault or anyone else.
    function invariant_noDanglingApprovals() public view {
        IERC20[5] memory ts = [IERC20(quote), IERC20(mid), IERC20(usdc), IERC20(meme), IERC20(weth)];
        address[3] memory spenders = [address(manager), address(vault), address(hook)];
        for (uint256 i; i < 5; ++i) {
            for (uint256 j; j < 3; ++j) {
                assertEq(ts[i].allowance(address(cons), spenders[j]), 0);
                assertEq(ts[i].allowance(address(hook), spenders[j]), 0);
            }
        }
    }

    /// A successful whole-balance conversion returned at least the per hop floor.
    function invariant_slippageGuardHonoured() public view {
        assertEq(badFills, 0);
    }

    /// The vault holds exactly what it tracks, split 10 / 90, and the tracked total never drops.
    function invariant_vaultBacked() public view {
        assertEq(vault.totalTracked(), usdc.balanceOf(address(vault)));
        assertEq(vault.platformAccrued() + vault.causePool(address(meme)), usdc.balanceOf(address(vault)));
        assertEq(trackedDrops, 0);
    }

    /// Held per-epoch parts always sum to the held total (conservation across partial retries).
    function invariant_heldConserved() public view {
        uint256 sum;
        uint256 current = governor.currentEpoch();
        for (uint256 e; e <= current; ++e) {
            sum += cons.heldFeesIn(address(meme), address(quote), e);
        }
        assertEq(sum, cons.heldFees(address(meme), address(quote)));
    }

    function test_reachesSuccess() public {
        quote.mint(address(cons), 1e18);
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), 1e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertGt(usdc.balanceOf(address(vault)), 0);
        assertEq(mid.balanceOf(address(cons)), 0);
    }

    /// Fuzz: a single whole balance conversion at any size either converts at or above the floor
    /// or leaves everything held; never a partial or bad-price fill.
    function testFuzz_convertOrHold(uint96 amountRaw, uint96 push, bool pushFirst, bool dir) public {
        uint256 amount = (uint256(amountRaw) % 2e22) + 1e12;
        PoolKey memory k = pushFirst ? quoteMidKey : midUsdcKey;
        try this.trade(k, dir, (uint256(push) % (pushFirst ? 6e22 : 4e22)) + 1e6) {} catch {}
        uint256 floor = _floorOut(amount);
        quote.mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(meme), address(quote), amount);
        uint256 held = cons.heldFees(address(meme), address(quote));
        if (held == 0) {
            assertGe(usdc.balanceOf(address(vault)), floor, "bad fill");
        } else {
            assertEq(held, amount);
            assertEq(usdc.balanceOf(address(vault)), 0);
        }
        assertEq(mid.balanceOf(address(cons)), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);
    }
}
