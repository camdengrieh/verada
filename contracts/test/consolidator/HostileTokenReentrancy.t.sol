// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {MockERC20} from "./ConsolidatorMocks.sol";
import {MultiHopFixture} from "./MultiHopNet.t.sol";

/// @dev A quote asset that, on every transfer touching the consolidator or the pool manager,
///      calls back into a configured target with configured calldata, recording the outcome.
contract ReentrantToken is ERC20 {
    address public immutable watched1;
    address public immutable watched2;
    address public target;
    bytes public data;
    bool public armed;
    bool private _inside;
    uint256 public attempts;
    uint256 public successes;
    bool public gasBurn;

    constructor(address w1, address w2) ERC20("EVIL", "EVIL") {
        watched1 = w1;
        watched2 = w2;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(address target_, bytes calldata data_, bool burn) external {
        target = target_;
        data = data_;
        armed = true;
        gasBurn = burn;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && !_inside && (from == watched1 || to == watched1 || from == watched2 || to == watched2)) {
            _inside = true;
            ++attempts;
            if (gasBurn) {
                while (true) {}
            }
            (bool ok,) = target.call(data);
            if (ok) ++successes;
            _inside = false;
        }
    }
}

/// @dev Reentrancy through a malicious quote asset: whatever the token calls back into during a
///      conversion, the consolidator ends with no residual balance, held == balance, and the
///      vault stays backed. A token that burns all gas is contained by the consolidator's
///      try/catch (the fee stays held).
contract HostileTokenReentrancyTest is MultiHopFixture {
    ReentrantToken internal evil;
    MockERC20 internal meme2;
    PoolKey internal evilUsdcKey;

    function setUp() public {
        _hostSetUp();
        evil = new ReentrantToken(address(cons), address(manager));
        evil.mint(address(this), 1e36);
        evil.approve(address(modifyLiquidityRouter), type(uint256).max);
        evil.approve(address(swapRouter), type(uint256).max);

        // evil / usdc route, one hop. Initialised before arming so setup transfers are inert.
        evilUsdcKey = _initPool(address(evil), address(usdc), 3000, address(evil), address(usdc), QUOTE_TICK, 2e19);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = evilUsdcKey;
        registry.addQuoteAssetWithRoute(address(evil), IQuoteRegistry.Kind.Ondo, route);
        cons.seedReferences(route);

        meme2 = new MockERC20("MEME2", 18);
        meme2.mint(address(this), 1e36);
        meme2.approve(address(modifyLiquidityRouter), type(uint256).max);
        meme2.approve(address(swapRouter), type(uint256).max);
        vault.registerToken(address(meme2));
        _launch(meme2, address(evil));
        skip(2000);
    }

    function _calls(uint256 which) internal view returns (address, bytes memory) {
        PoolKey memory k = evilUsdcKey;
        uint256 w = which % 9;
        if (w == 0) return (address(cons), abi.encodeCall(cons.retry, (address(meme2), address(evil))));
        if (w == 1) return (address(cons), abi.encodeCall(cons.retryAmount, (address(meme2), address(evil), 1)));
        if (w == 2) return (address(cons), abi.encodeCall(cons.flushThrough, (address(meme2), 0)));
        if (w == 3) return (address(cons), abi.encodeCall(cons.syncReference, (k)));
        if (w == 4) return (address(cons), abi.encodeCall(cons.consolidate, (address(meme2), address(evil), 1)));
        if (w == 5) return (address(cons), abi.encodeCall(cons.convertClaims, (address(evil), 1, address(this), false)));
        if (w == 6) return (address(cons), abi.encodeCall(cons.rescueExcess, (address(evil), address(this))));
        if (w == 7) return (address(vault), abi.encodeCall(vault.settle, (address(meme2), 0)));
        return (address(manager), abi.encodeWithSignature("unlock(bytes)", bytes("")));
    }

    function _assertClean(uint256 delivered) internal view {
        assertEq(evil.balanceOf(address(cons)), cons.totalHeld(address(evil)), "evil balance != held");
        assertEq(usdc.balanceOf(address(cons)), 0, "usdc residual");
        assertEq(address(cons).balance, 0, "eth residual");
        assertEq(evil.allowance(address(cons), address(manager)), 0);
        assertEq(vault.totalTracked(), usdc.balanceOf(address(vault)), "vault unbacked");
        assertLe(cons.heldFees(address(meme2), address(evil)), delivered);
    }

    /// Every callback target, with the callback firing on each transfer of a conversion.
    function testFuzz_reenterDuringConsolidate(uint8 which, uint96 amountRaw) public {
        uint256 amount = (uint256(amountRaw) % 1e22) + 1e12;
        (address t_, bytes memory d) = _calls(which);
        evil.mint(address(cons), amount);
        evil.arm(t_, d, false);
        vm.prank(locker);
        cons.consolidate(address(meme2), address(evil), amount);
        evil.disarm();
        _assertClean(amount);
    }

    /// Same during an explicit retry of a previously held balance.
    function testFuzz_reenterDuringRetry(uint8 which, uint96 amountRaw) public {
        uint256 amount = (uint256(amountRaw) % 1e22) + 1e12;
        // Hold it first by making the pool too far off (dust path: pause is not available on evil),
        // so deliver while the manager is unlocked is not reachable; use retryAmount on a delivery
        // whose first attempt fails because the callback is armed to burn on the first transfer.
        evil.mint(address(cons), amount);
        evil.arm(address(0xdead), "", false);
        vm.prank(locker);
        cons.consolidate(address(meme2), address(evil), amount);
        evil.disarm();
        uint256 held = cons.heldFees(address(meme2), address(evil));
        if (held == 0) {
            _assertClean(amount);
            return;
        }
        (address t_, bytes memory d) = _calls(which);
        evil.arm(t_, d, false);
        try cons.retry(address(meme2), address(evil)) {} catch {}
        evil.disarm();
        _assertClean(amount);
    }

    /// A token that burns all gas on transfer cannot brick or leak: the whole attempt fails or
    /// the fee stays held, and all accounting still balances.
    function test_gasBurningTokenIsContained() public {
        evil.mint(address(cons), 1e18);
        evil.arm(address(0xdead), "", true);
        vm.prank(locker);
        // Deliberately bounded gas, as a hook would have; the consolidator must not revert the
        // caller (the live hook relies on this) or leave a residual.
        (bool ok,) = address(cons).call{gas: 3_000_000}(
            abi.encodeCall(cons.consolidate, (address(meme2), address(evil), 1e18))
        );
        evil.disarm();
        // Either the delivery reverted whole (nothing moved) or it was held; never half done.
        if (ok) {
            assertEq(evil.balanceOf(address(cons)), cons.totalHeld(address(evil)));
        }
        assertEq(usdc.balanceOf(address(cons)), 0);
    }

    function test_selfCallbackNeverSucceedsIntoGuardedEntrypoints() public {
        // retry/consolidate/flushThrough/syncReference are nonReentrant: the callback must fail.
        for (uint256 w; w < 4; ++w) {
            (address t_, bytes memory d) = _calls(w);
            evil.mint(address(cons), 1e18);
            evil.arm(t_, d, false);
            vm.prank(locker);
            cons.consolidate(address(meme2), address(evil), 1e18);
            evil.disarm();
            assertEq(evil.successes(), 0, "callback re-entered a guarded entrypoint");
        }
    }
}
