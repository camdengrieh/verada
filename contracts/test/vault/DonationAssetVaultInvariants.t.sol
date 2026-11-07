// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {DonationAsset} from "../../src/interfaces/IDonationAsset.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {MockDistributor, MockERC20, MockGovernor, single} from "../consolidator/ConsolidatorMocks.sol";

contract WethAwareConsolidator {
    address public weth;

    constructor(address weth_) {
        weth = weth_;
    }

    function flushThrough(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev Two assets in one vault: tokens 0 and 1 are USDC tokens, tokens 2 and 3 are ETH tokens.
contract DonationAssetVaultHandler is Test {
    FeeVault public vault;
    MockGovernor public governor;
    MockERC20 public usdc;
    MockERC20 public weth;
    address public consolidator;
    address[] public tokens;
    uint256 public inUsdc;
    uint256 public inWeth;
    uint256 public outTreasuryUsdc;
    uint256 public outTreasuryWeth;
    uint256 public outDistUsdc;
    uint256 public outDistWeth;

    constructor(FeeVault v, MockGovernor g, MockERC20 u, MockERC20 w, address c, address[] memory t) {
        vault = v;
        governor = g;
        usdc = u;
        weth = w;
        consolidator = c;
        tokens = t;
    }

    function _isEth(uint256 i) internal pure returns (bool) {
        return i >= 2;
    }

    function deposit(uint256 seed, uint96 amount) external {
        uint256 i = seed % tokens.length;
        if (_isEth(i)) {
            weth.mint(address(vault), amount);
            inWeth += amount;
        } else {
            usdc.mint(address(vault), amount);
            inUsdc += amount;
        }
        vm.prank(consolidator);
        vault.depositFees(tokens[i], single(governor.currentEpoch()), single(amount));
    }

    function advanceEpoch() external {
        governor.setCurrentEpoch(governor.currentEpoch() + 1);
    }

    function withdrawPlatform() external {
        uint256 u = vault.platformAccrued();
        uint256 w = vault.platformAccruedEth();
        if (u == 0 && w == 0) return;
        vault.withdrawPlatform();
        outTreasuryUsdc += u;
        outTreasuryWeth += w;
    }

    function settle(uint256 seed, uint256 epochSeed) external {
        uint256 i = seed % tokens.length;
        uint256 current = governor.currentEpoch();
        if (current == 0) return;
        uint256 epoch = epochSeed % current;
        uint256 amt = vault.causePoolOf(tokens[i], epoch);
        if (amt == 0) return;
        governor.setFinalized(tokens[i], epoch, true);
        vault.settle(tokens[i], epoch);
        if (_isEth(i)) outDistWeth += amt;
        else outDistUsdc += amt;
    }
}

/// @notice Invariants V1 per asset: the vault holds at least (here exactly) platform plus every
///         cause pool of that asset, the ledgers never mix, and value is conserved per asset.
contract DonationAssetVaultInvariantTest is Test {
    FeeVault vault;
    MockERC20 usdc;
    MockERC20 weth;
    MockDistributor distributor;
    DonationAssetVaultHandler handler;
    address[] tokens;
    address factory = makeAddr("factory");
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);
        MockGovernor governor = new MockGovernor();
        distributor = new MockDistributor();
        vault = new FeeVault(
            address(this), factory, treasury, IEpochGovernor(address(governor)), address(distributor), address(usdc)
        );
        address cons = address(new WethAwareConsolidator(address(weth)));
        vault.setConsolidator(cons);
        for (uint256 i; i < 4; ++i) {
            address t = address(uint160(0x2000 + i));
            tokens.push(t);
            vm.prank(factory);
            vault.registerToken(t, i >= 2 ? DonationAsset.Eth : DonationAsset.Usdc);
        }
        handler = new DonationAssetVaultHandler(vault, governor, usdc, weth, cons, tokens);
        targetContract(address(handler));
    }

    function _pools(bool eth) internal view returns (uint256 s) {
        for (uint256 i = eth ? 2 : 0; i < (eth ? 4 : 2); ++i) {
            s += vault.causePool(tokens[i]);
        }
    }

    function invariant_perAssetBacked() public view {
        assertEq(usdc.balanceOf(address(vault)), vault.platformAccrued() + _pools(false));
        assertEq(weth.balanceOf(address(vault)), vault.platformAccruedEth() + _pools(true));
        assertEq(vault.totalTracked(), usdc.balanceOf(address(vault)));
        assertEq(vault.totalTrackedEth(), weth.balanceOf(address(vault)));
    }

    function invariant_perAssetValueConserved() public view {
        assertEq(
            usdc.balanceOf(address(vault)) + usdc.balanceOf(treasury) + usdc.balanceOf(address(distributor)),
            handler.inUsdc()
        );
        assertEq(
            weth.balanceOf(address(vault)) + weth.balanceOf(treasury) + weth.balanceOf(address(distributor)),
            handler.inWeth()
        );
        assertEq(weth.balanceOf(treasury), handler.outTreasuryWeth());
        assertEq(usdc.balanceOf(treasury), handler.outTreasuryUsdc());
    }

    function test_ethRegistrationNeedsWeth() public {
        FeeVault v2 = new FeeVault(
            address(this), factory, treasury, IEpochGovernor(address(new MockGovernor())), address(distributor), address(usdc)
        );
        vm.prank(factory);
        vm.expectRevert(FeeVault.EthUnsupported.selector);
        v2.registerToken(address(0x9999), DonationAsset.Eth);
    }
}
