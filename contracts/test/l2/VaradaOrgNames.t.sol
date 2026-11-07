// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {VaradaOrgNames} from "../../src/l2/VaradaOrgNames.sol";

contract VaradaOrgNamesTest is Test {
    VaradaOrgNames internal reg;
    address internal owner = makeAddr("owner");
    address internal registrar = makeAddr("registrar");
    address internal custody = makeAddr("custody");
    address internal charity = makeAddr("charity");

    function setUp() public {
        reg = new VaradaOrgNames(owner, "https://varada.eth.limo/org-token/");
        vm.prank(owner);
        reg.setRegistrar(registrar, true);
    }

    function _one(string memory label, bytes32 orgId)
        internal
        pure
        returns (VaradaOrgNames.Registration[] memory r)
    {
        r = new VaradaOrgNames.Registration[](1);
        r[0] = VaradaOrgNames.Registration(label, orgId);
    }

    function test_registerMintsAndRecordsAtTheDocumentedSlot() public {
        vm.prank(registrar);
        reg.register(_one("american-red-cross", bytes32("530196605")), custody);
        bytes32 lh = keccak256("american-red-cross");
        assertEq(reg.ownerOf(uint256(lh)), custody);
        assertEq(reg.defaultOrgIdOf(lh), bytes32("530196605"));
        // The resolver's proof request reads this exact slot.
        bytes32 slot = keccak256(abi.encode(lh, keccak256("varada.orgnames.defaultOrgId")));
        assertEq(slot, reg.defaultSlot(lh));
        assertEq(vm.load(address(reg), slot), bytes32("530196605"));
        assertEq(reg.orgIdOf(lh, 1), bytes32("530196605"));
        assertEq(reg.orgIdOf(lh, 8453), bytes32("530196605"));
    }

    function test_chainOverridesAndNone() public {
        bytes32 lh = keccak256("national-public-radio");
        vm.startPrank(registrar);
        reg.register(_one("national-public-radio", bytes32("520907625")), custody);
        VaradaOrgNames.ChainOverride[] memory o = new VaradaOrgNames.ChainOverride[](2);
        o[0] = VaradaOrgNames.ChainOverride(lh, 8453, bytes32("52-0907625"));
        o[1] = VaradaOrgNames.ChainOverride(lh, 10, reg.NONE());
        reg.setChainOrgIds(o);
        vm.stopPrank();
        assertEq(reg.orgIdOf(lh, 1), bytes32("520907625"));
        assertEq(reg.orgIdOf(lh, 8453), bytes32("52-0907625"));
        assertEq(reg.orgIdOf(lh, 10), bytes32(0));
        bytes32 slot = keccak256(
            abi.encode(
                uint256(8453), keccak256(abi.encode(lh, keccak256("varada.orgnames.chainOrgId")))
            )
        );
        assertEq(slot, reg.chainSlot(lh, 8453));
        assertEq(vm.load(address(reg), slot), bytes32("52-0907625"));
        // Clearing an override returns to the default.
        o = new VaradaOrgNames.ChainOverride[](1);
        o[0] = VaradaOrgNames.ChainOverride(lh, 10, bytes32(0));
        vm.prank(registrar);
        reg.setChainOrgIds(o);
        assertEq(reg.orgIdOf(lh, 10), bytes32("520907625"));
    }

    function test_claimIsATransferAndRecordsStay() public {
        vm.prank(registrar);
        reg.register(_one("american-red-cross", bytes32("530196605")), custody);
        uint256 id = uint256(keccak256("american-red-cross"));
        vm.prank(custody);
        reg.transferFrom(custody, charity, id);
        assertEq(reg.ownerOf(id), charity);
        assertEq(reg.defaultOrgIdOf(bytes32(id)), bytes32("530196605"));
        // The charity holds the name but cannot repoint where it sends funds.
        vm.prank(charity);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgNames.NotRegistrar.selector, charity));
        reg.setDefaultOrgId(bytes32(id), bytes32("1"));
    }

    function test_rejectsDuplicatesBadLabelsZeroIdsAndStrangers() public {
        vm.startPrank(registrar);
        reg.register(_one("dup", bytes32("1")), custody);
        vm.expectRevert(); // ERC721InvalidSender: already minted
        reg.register(_one("dup", bytes32("2")), custody);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgNames.InvalidLabel.selector, ""));
        reg.register(_one("", bytes32("1")), custody);
        string memory long = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 64
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgNames.InvalidLabel.selector, long));
        reg.register(_one(long, bytes32("1")), custody);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgNames.ZeroOrgId.selector, keccak256("z")));
        reg.register(_one("z", bytes32(0)), custody);
        vm.expectRevert(
            abi.encodeWithSelector(VaradaOrgNames.UnknownName.selector, keccak256("missing"))
        );
        reg.setDefaultOrgId(keccak256("missing"), bytes32("1"));
        vm.stopPrank();

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgNames.NotRegistrar.selector, stranger));
        reg.register(_one("x", bytes32("1")), custody);
        vm.prank(stranger);
        vm.expectRevert();
        reg.setRegistrar(stranger, true);
    }

    function test_gas_registerBatchOf200() public {
        VaradaOrgNames.Registration[] memory r = new VaradaOrgNames.Registration[](200);
        for (uint256 i; i < 200; ++i) {
            r[i] = VaradaOrgNames.Registration(
                string.concat("some-charity-name-", vm.toString(i)),
                bytes32(uint256(100_000_000 + i))
            );
        }
        vm.prank(registrar);
        uint256 g = gasleft();
        reg.register(r, custody);
        uint256 used = g - gasleft();
        emit log_named_uint("gas per name (batch of 200)", used / 200);
        assertLt(used / 200, 80_000);
    }
}
