// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {V3PoolSwapper} from "../../src/community/V3PoolSwapper.sol";
import {IV3PoolSwapper} from "../../src/interfaces/IV3PoolSwapper.sol";
import {MockERC20} from "../consolidator/ConsolidatorMocks.sol";

interface IPoolSwap {
    function swap(address, bool, int256, uint160, bytes calldata)
        external
        returns (int256, int256);
}

/// @dev A pool-shaped contract deployed by `HostileFactory` at the CREATE2 address the swapper
///      derives. Behaviour is set per test. It is NOT UniswapV3Pool code: it models what a
///      deceptive pool could try if the init code hash were wrong or the factory dishonest.
contract HostilePool {
    enum Mode {
        Honest, // pays 1:1, asks exactly amountIn
        OverAsk, // asks twice amountIn
        SplitAsk, // asks amountIn in two halves plus one extra unit
        NoPay, // never calls the callback and sends nothing
        Reenter, // calls swapExactIn again from inside the callback
        WrongPayee // pulls through the callback, sends output to nobody
    }

    Mode public mode;
    address public tokenIn;
    address public tokenOut;
    V3PoolSwapper public swapper;
    address public poolFactory;

    function setFactory(address f) external {
        poolFactory = f;
    }

    function configure(Mode m, address tin, address tout, V3PoolSwapper s) external {
        mode = m;
        tokenIn = tin;
        tokenOut = tout;
        swapper = s;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256, int256)
    {
        uint256 amt = uint256(amountSpecified);
        if (mode == Mode.NoPay) return (0, 0);
        if (mode == Mode.OverAsk) {
            swapper.uniswapV3SwapCallback(int256(amt * 2), -int256(amt), "");
        } else if (mode == Mode.SplitAsk) {
            swapper.uniswapV3SwapCallback(int256(amt / 2), 0, "");
            swapper.uniswapV3SwapCallback(int256(amt / 2) + 1, 0, "");
        } else if (mode == Mode.Reenter) {
            swapper.swapExactIn(
                poolFactory, tokenIn, tokenOut, 3000, 1, 0, 0, recipient, type(uint256).max
            );
        } else {
            swapper.uniswapV3SwapCallback(int256(amt), -int256(amt), "");
        }
        if (mode == Mode.Honest) IERC20(tokenOut).transfer(recipient, amt);
        return (int256(amt), -int256(amt));
    }
}

contract HostileFactory {
    function create(address a, address b, uint24 fee) external returns (address pool) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pool = address(
            new HostilePool{salt: keccak256(abi.encode(t0, t1, fee))}()
        );
    }
}

contract V3PoolSwapperTest is Test {
    V3PoolSwapper internal swapper;
    HostileFactory internal factory;
    MockERC20 internal tin;
    MockERC20 internal tout;
    HostilePool internal pool;
    bytes32 internal hash;

    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        factory = new HostileFactory();
        hash = keccak256(type(HostilePool).creationCode);
        address[] memory f = new address[](1);
        bytes32[] memory h = new bytes32[](1);
        f[0] = address(factory);
        h[0] = hash;
        swapper = new V3PoolSwapper(f, h);

        tin = new MockERC20("IN", 18);
        tout = new MockERC20("OUT", 6);
        pool = HostilePool(factory.create(address(tin), address(tout), 3000));
        assertEq(
            address(pool), swapper.poolOf(address(factory), address(tin), address(tout), 3000)
        );

        tin.mint(payer, 1_000e18);
        tout.mint(address(pool), 1_000_000e18);
        vm.prank(payer);
        tin.approve(address(swapper), type(uint256).max);
    }

    function _swap(uint256 amountIn, uint256 minOut) internal returns (uint256, uint256) {
        return swapper.swapExactIn(
            address(factory),
            address(tin),
            address(tout),
            3000,
            amountIn,
            minOut,
            0,
            recipient,
            block.timestamp
        );
    }

    function _configure(HostilePool.Mode m) internal {
        pool.configure(m, address(tin), address(tout), swapper);
    }

    // ------------------------------------------------------------------ happy path

    function test_honestPoolSwapMovesExactAmounts() public {
        _configure(HostilePool.Mode.Honest);
        vm.prank(payer);
        (uint256 spent, uint256 got) = _swap(100e18, 100e18);
        assertEq(spent, 100e18);
        assertEq(got, 100e18);
        assertEq(tin.balanceOf(payer), 900e18);
        assertEq(tin.balanceOf(address(pool)), 100e18);
        assertEq(tout.balanceOf(recipient), 100e18);
        assertEq(tin.balanceOf(address(swapper)), 0);
        assertEq(tout.balanceOf(address(swapper)), 0);
        assertEq(tin.allowance(address(swapper), address(pool)), 0);
    }

    // ------------------------------------------------------------------ hostile callbacks

    function test_callbackOutsideSwapReverts() public {
        vm.expectRevert(IV3PoolSwapper.NotSwapping.selector);
        swapper.uniswapV3SwapCallback(int256(1e18), 0, "");
    }

    function test_callbackFromOtherAddressMidSwapReverts() public {
        // A hostile token that calls the callback while the swap is in flight.
        CallbackAttacker attacker = new CallbackAttacker(swapper);
        // The pool's output token is the attacker's: its transfer calls the callback.
        pool = HostilePool(factory.create(address(tin), address(attacker), 500));
        pool.configure(HostilePool.Mode.Honest, address(tin), address(attacker), swapper);
        attacker.mint(address(pool), 1_000e18);
        attacker.armFor(payer);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IV3PoolSwapper.NotThePool.selector, address(attacker))
        );
        swapper.swapExactIn(
            address(factory),
            address(tin),
            address(attacker),
            500,
            10e18,
            0,
            0,
            recipient,
            block.timestamp
        );
    }

    function test_poolAskingMoreThanAmountInReverts() public {
        _configure(HostilePool.Mode.OverAsk);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.OwedTooMuch.selector, 200e18, 100e18));
        _swap(100e18, 0);
        assertEq(tin.balanceOf(payer), 1_000e18);
    }

    function test_poolCallingBackTwiceCannotExceedAmountIn() public {
        _configure(HostilePool.Mode.SplitAsk);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.OwedTooMuch.selector, 50e18 + 1, 50e18));
        _swap(100e18, 0);
    }

    function test_poolThatNeverPaysFailsMinOut() public {
        _configure(HostilePool.Mode.NoPay);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.TooLittleReceived.selector, 0, 1));
        _swap(100e18, 1);
    }

    function test_poolThatTakesInputButSendsNothingFailsMinOut() public {
        _configure(HostilePool.Mode.WrongPayee);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.TooLittleReceived.selector, 0, 1));
        _swap(100e18, 1);
        // The revert returns the input.
        assertEq(tin.balanceOf(payer), 1_000e18);
    }

    function test_reentrantSwapReverts() public {
        _configure(HostilePool.Mode.Reenter);
        pool.setFactory(address(factory));
        vm.prank(payer);
        vm.expectRevert(IV3PoolSwapper.Reentered.selector);
        _swap(100e18, 0);
    }

    // ------------------------------------------------------------------ guards

    function test_unknownFactoryRejected() public {
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.FactoryNotAllowed.selector, payer));
        swapper.swapExactIn(
            payer, address(tin), address(tout), 3000, 1, 0, 0, recipient, block.timestamp
        );
    }

    function test_missingPoolRejected() public {
        address p = swapper.poolOf(address(factory), address(tin), address(tout), 100);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.PoolMissing.selector, p));
        swapper.swapExactIn(
            address(factory), address(tin), address(tout), 100, 1, 0, 0, recipient, block.timestamp
        );
    }

    function test_deadlineAndInputValidation() public {
        vm.warp(1000);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.DeadlinePassed.selector, 999));
        swapper.swapExactIn(address(factory), address(tin), address(tout), 3000, 1, 0, 0, recipient, 999);
        vm.expectRevert(IV3PoolSwapper.ZeroAmount.selector);
        swapper.swapExactIn(address(factory), address(tin), address(tout), 3000, 0, 0, 0, recipient, 1000);
        vm.expectRevert(IV3PoolSwapper.InvalidPair.selector);
        swapper.swapExactIn(address(factory), address(tin), address(tin), 3000, 1, 0, 0, recipient, 1000);
        vm.expectRevert(IV3PoolSwapper.InvalidRecipient.selector);
        swapper.swapExactIn(
            address(factory), address(tin), address(tout), 3000, 1, 0, 0, address(swapper), 1000
        );
    }

    function test_constructorRejectsBadInput() public {
        address[] memory f = new address[](1);
        bytes32[] memory h = new bytes32[](2);
        vm.expectRevert(IV3PoolSwapper.LengthMismatch.selector);
        new V3PoolSwapper(f, h);
        h = new bytes32[](1);
        vm.expectRevert(IV3PoolSwapper.ZeroAddress.selector);
        new V3PoolSwapper(f, h);
    }

    function test_thirdPartyCannotSpendAnotherApproval() public {
        _configure(HostilePool.Mode.Honest);
        // `recipient` has no tokens and no approval; the payer is always msg.sender.
        vm.prank(recipient);
        vm.expectRevert();
        _swap(100e18, 0);
        assertEq(tin.balanceOf(payer), 1_000e18);
    }
}

/// @dev An output token whose transfer calls the swapper callback (as the token, not the pool).
contract CallbackAttacker is MockERC20 {
    V3PoolSwapper internal immutable swapper;
    address internal victim;

    constructor(V3PoolSwapper s) MockERC20("ATK", 18) {
        swapper = s;
    }

    function armFor(address v) external {
        victim = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (victim != address(0)) swapper.uniswapV3SwapCallback(int256(1e18), 0, "");
        return super.transfer(to, amount);
    }
}
