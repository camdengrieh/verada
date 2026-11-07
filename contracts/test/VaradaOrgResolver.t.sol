// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {VaradaOrgResolver} from "../src/VaradaOrgResolver.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {VaradaOrgNames} from "../src/l2/VaradaOrgNames.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {OffchainLookup} from "../src/vendor/unruggable/GatewayFetchTarget.sol";
import {GatewayRequest} from "../src/vendor/unruggable/GatewayRequest.sol";
import {IGatewayProtocol} from "../src/vendor/unruggable/IGatewayProtocol.sol";
import {IGatewayVerifier} from "../src/vendor/unruggable/IGatewayVerifier.sol";

contract StubOrgFactory {
    function computeOrgAddress(bytes32 orgId) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("org", orgId)))));
    }
}

/// @notice Stands in for the Unruggable verifier plus gateway. A "proof" is
///         `abi.encode(keccak256(req.ops), bytes[] values)`; the verifier checks the request
///         hash so a test cannot answer a different request than the resolver built.
contract MockGatewayVerifier is IGatewayVerifier {
    bytes public constant CONTEXT = "ctx";

    error WrongRequest();

    function getLatestContext() external pure returns (bytes memory) {
        return CONTEXT;
    }

    function gatewayURLs() external pure returns (string[] memory) {
        return new string[](0);
    }

    function getStorageValues(bytes memory context, GatewayRequest memory req, bytes memory proof)
        external
        pure
        returns (bytes[] memory values, uint8 exitCode)
    {
        require(keccak256(context) == keccak256(CONTEXT), "context");
        (bytes32 reqHash, bytes[] memory v) = abi.decode(proof, (bytes32, bytes[]));
        if (reqHash != keccak256(req.ops)) revert WrongRequest();
        return (v, 0);
    }
}

/// @notice Sharded names tree helpers (OpenZeppelin standard tree, leaf `(uint256 shard,
///         bytes32 keccak256(abi.encode(entries)))`), shared with the fork tests. Trees here use
///         0 or 1 shard bits so they can be built in a test; the catalogue uses 12.
library ShardTree {
    function entry(bytes32 lh, bytes32 id) internal pure returns (VaradaOrgResolver.Entry memory) {
        return VaradaOrgResolver.Entry(lh, id, id, id);
    }

    function shardOf(bytes32 lh, uint8 bits) internal pure returns (uint256) {
        return bits == 0 ? 0 : uint256(lh) >> (256 - uint256(bits));
    }

    function entriesOf(VaradaOrgResolver.Entry[] memory all, uint256 shard, uint8 bits)
        internal
        pure
        returns (VaradaOrgResolver.Entry[] memory out)
    {
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (shardOf(all[i].labelhash, bits) == shard) ++n;
        }
        out = new VaradaOrgResolver.Entry[](n);
        n = 0;
        for (uint256 i; i < all.length; ++i) {
            if (shardOf(all[i].labelhash, bits) == shard) out[n++] = all[i];
        }
    }

    function leaf(uint256 shard, VaradaOrgResolver.Entry[] memory es)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(shard, keccak256(abi.encode(es))))));
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @dev Root for `bits` 0 (one shard) or 1 (two shards).
    function root(VaradaOrgResolver.Entry[] memory all, uint8 bits)
        internal
        pure
        returns (bytes32)
    {
        if (bits == 0) return leaf(0, all);
        return pair(leaf(0, entriesOf(all, 0, 1)), leaf(1, entriesOf(all, 1, 1)));
    }

    function proof(VaradaOrgResolver.Entry[] memory all, uint256 shard, uint8 bits)
        internal
        pure
        returns (bytes32[] memory p)
    {
        if (bits == 0) return new bytes32[](0);
        p = new bytes32[](1);
        p[0] = leaf(1 - shard, entriesOf(all, 1 - shard, 1));
    }

    /// @dev The gateway's answer for `shard`: what the static Swarm file holds.
    function answer(VaradaOrgResolver.Entry[] memory all, uint256 shard, uint8 bits)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            root(all, bits), shard, entriesOf(all, shard, bits), proof(all, shard, bits)
        );
    }
}

/// @notice Minimal EIP-3668 client: follows OffchainLookup reverts, answering Unruggable
///         `proveRequest` calls from `l2` state and everything else from the Merkle tree.
abstract contract CcipHarness is Test {
    struct L2Record {
        bool set;
        bytes32 defaultId;
        bytes32[3] overrides; // chains 1, 10, 8453
    }

    mapping(bytes32 => L2Record) internal l2;
    VaradaOrgResolver.Entry[] internal mEntries;
    uint8 internal constant BITS = 1;
    bytes32 internal merkleRoot;
    uint256 internal l2Lookups;
    uint256 internal merkleLookups;

    function _ccip(address target, bytes memory call) internal returns (bytes memory) {
        for (uint256 hop; hop < 6; ++hop) {
            (bool ok, bytes memory ret) = target.staticcall(call);
            if (ok) return ret;
            if (bytes4(ret) != OffchainLookup.selector) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            (address sender,, bytes memory req, bytes4 cb, bytes memory carry) =
                abi.decode(_tail(ret), (address, string[], bytes, bytes4, bytes));
            target = sender;
            call = abi.encodeWithSelector(cb, _gateway(req), carry);
        }
        revert("too many hops");
    }

    function _gateway(bytes memory req) internal virtual returns (bytes memory) {
        if (bytes4(req) == IGatewayProtocol.proveRequest.selector) {
            ++l2Lookups;
            (, GatewayRequest memory r) = abi.decode(_tail(req), (bytes, GatewayRequest));
            bytes32 lh = _labelhashFor(r);
            L2Record storage rec = l2[lh];
            bytes[] memory values = new bytes[](4);
            values[0] = abi.encode(rec.set ? rec.defaultId : bytes32(0));
            for (uint256 i; i < 3; ++i) {
                values[i + 1] = abi.encode(rec.overrides[i]);
            }
            return abi.encode(keccak256(r.ops), values);
        }
        ++merkleLookups;
        uint256 shard = abi.decode(req, (uint256));
        return ShardTree.answer(mEntries, shard, BITS);
    }

    /// @dev Tests know every labelhash they ask about; find the one whose request matches.
    function _labelhashFor(GatewayRequest memory r) internal view virtual returns (bytes32);

    function _tail(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i + 4];
        }
    }
}

contract VaradaOrgResolverTest is CcipHarness {
    bytes internal constant NS = hex"036f7267067661726164610365746800"; // org.varada.eth
    uint256 internal constant OP = 0x80000000 | 10;
    uint256 internal constant BASE = 0x80000000 | 8453;

    StubOrgFactory internal factory;
    MockGatewayVerifier internal mockVerifier;
    VaradaOrgResolver internal resolver;
    address internal owner = makeAddr("owner");
    address internal l2Registry = makeAddr("l2-registry");

    bytes32 internal redCross = bytes32("530196605");
    bytes32 internal crossroads = bytes32("237093881");
    bytes32 internal lhRed = keccak256("american-red-cross");
    bytes32 internal lhCross = keccak256("crossroads-harmony");
    bytes32 internal lhNpr = keccak256("national-public-radio");
    bytes32 internal npr = bytes32("520907625");
    bytes32 internal nprBase = bytes32("52-0907625");
    bytes32[] internal known;

    function setUp() public {
        factory = new StubOrgFactory();
        mockVerifier = new MockGatewayVerifier();
        mEntries.push(ShardTree.entry(lhRed, redCross));
        mEntries.push(ShardTree.entry(lhCross, crossroads));
        merkleRoot = ShardTree.root(mEntries, BITS);
        known.push(lhRed);
        known.push(lhCross);
        known.push(lhNpr);
        known.push(keccak256("nobody"));
        resolver = _deploy(merkleRoot, BITS);
    }

    function _answerFor(bytes32 lh) internal view returns (bytes memory) {
        return ShardTree.answer(mEntries, ShardTree.shardOf(lh, BITS), BITS);
    }

    function _deploy(bytes32 root_, uint8 bits) internal returns (VaradaOrgResolver) {
        string[] memory urls = new string[](1);
        urls[0] = "https://gw.example/ccip/{sender}/{data}.json";
        string[] memory l2Urls = new string[](1);
        l2Urls[0] = "https://optimism.gateway.unruggable.com";
        return new VaradaOrgResolver(
            owner,
            IEndaomentOrgFundFactory(address(factory)),
            NS,
            root_,
            bits,
            urls,
            "https://varada.eth.limo/org/",
            l2Registry,
            mockVerifier,
            l2Urls
        );
    }

    function _labelhashFor(GatewayRequest memory r) internal view override returns (bytes32) {
        for (uint256 i; i < known.length; ++i) {
            if (keccak256(resolver.l2Request(known[i]).ops) == keccak256(r.ops)) return known[i];
        }
        revert("unknown request");
    }

    function _resolve(string memory dotted, bytes memory data) internal returns (bytes memory) {
        bytes memory ret = _ccip(
            address(resolver),
            abi.encodeCall(IExtendedResolver.resolve, (DnsNameLib.encode(dotted), data))
        );
        return abi.decode(ret, (bytes));
    }

    function _node(string memory dotted) internal pure returns (bytes32) {
        return DnsNameLib.namehash(DnsNameLib.encode(dotted), 0);
    }

    function _addr(string memory n, uint256 coinType) internal returns (bytes memory) {
        return abi.decode(
            _resolve(n, abi.encodeCall(IAddressResolver.addr, (_node(n), coinType))), (bytes)
        );
    }

    // ------------------------------------------------------------------ L2 path

    function test_finalizedL2RecordResolvesWithoutTheMerkleGateway() public {
        l2[lhRed].set = true;
        l2[lhRed].defaultId = redCross;
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory want = abi.encodePacked(factory.computeOrgAddress(redCross));
        assertEq(_addr(n, 60), want);
        assertEq(_addr(n, OP), want);
        assertEq(_addr(n, BASE), want);
        assertEq(merkleLookups, 0, "no fallback");
        assertEq(l2Lookups, 3);
    }

    function test_l2RecordWinsOverTheMerkleTree() public {
        // The registrar repointed the name on Optimism after the tree was built.
        bytes32 newer = bytes32("999999999");
        l2[lhRed].set = true;
        l2[lhRed].defaultId = newer;
        assertEq(
            _addr("american-red-cross.org.varada.eth", 60),
            abi.encodePacked(factory.computeOrgAddress(newer))
        );
        assertEq(merkleLookups, 0);
    }

    function test_l2PerChainOverridesAndNone() public {
        l2[lhNpr].set = true;
        l2[lhNpr].defaultId = npr;
        l2[lhNpr].overrides[2] = nprBase; // Base
        string memory n = "national-public-radio.org.varada.eth";
        assertEq(_addr(n, 60), abi.encodePacked(factory.computeOrgAddress(npr)));
        assertEq(_addr(n, OP), abi.encodePacked(factory.computeOrgAddress(npr)));
        assertEq(_addr(n, BASE), abi.encodePacked(factory.computeOrgAddress(nprBase)));

        l2[lhNpr].overrides[1] = bytes32(type(uint256).max); // NONE on Optimism
        assertEq(_addr(n, OP).length, 0);
        assertEq(_addr(n, 60), abi.encodePacked(factory.computeOrgAddress(npr)));
    }

    function _l2Lookup(string memory n, bytes memory data)
        internal
        view
        returns (bytes memory extra)
    {
        try resolver.resolve(DnsNameLib.encode(n), data) {
            revert("expected lookup");
        } catch (bytes memory err) {
            bytes4 cb;
            (,,, cb, extra) = abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            assertEq(cb, resolver.l2Callback.selector);
        }
    }

    function _expectMerkleLookup(bytes memory err) internal view {
        assertEq(bytes4(err), OffchainLookup.selector, "not a lookup");
        (address sender, string[] memory urls,, bytes4 cb,) =
            abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
        assertEq(sender, address(resolver));
        assertEq(urls[0], "https://gw.example/ccip/{sender}/{data}.json");
        assertEq(cb, resolver.resolveCallback.selector);
    }

    function test_proofForAnotherRequestFallsBackToTheMerkleRoot() public {
        l2[lhRed].set = true;
        l2[lhRed].defaultId = crossroads;
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory extra = _l2Lookup(n, abi.encodeCall(IAddrResolver.addr, (_node(n))));
        // Values proven for crossroads' request, replayed for red cross: the verifier rejects
        // them, so the resolver falls back to the Merkle root instead of trusting them.
        bytes[] memory values = new bytes[](4);
        values[0] = abi.encode(crossroads);
        for (uint256 i = 1; i < 4; ++i) {
            values[i] = abi.encode(bytes32(0));
        }
        bytes memory proof = abi.encode(keccak256(resolver.l2Request(lhCross).ops), values);
        try resolver.l2Callback(proof, extra) {
            revert("expected fallback");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
        }
    }

    function test_emptyProofFromOurLastResortGatewayFallsBackAndResolves() public {
        // Public Optimism gateways are down; our own last URL answers "0x".
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory extra = _l2Lookup(n, abi.encodeCall(IAddrResolver.addr, (_node(n))));
        try resolver.l2Callback("", extra) {
            revert("expected fallback");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
            (,,,, bytes memory carry) =
                abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            bytes memory out = resolver.resolveCallback(_answerFor(lhRed), carry);
            assertEq(abi.decode(out, (address)), factory.computeOrgAddress(redCross));
        }
    }

    function test_verifierDownGoesStraightToTheMerkleRoot() public {
        vm.mockCallRevert(
            address(mockVerifier),
            abi.encodeWithSelector(IGatewayVerifier.getLatestContext.selector),
            "rollup upgraded"
        );
        string memory n = "american-red-cross.org.varada.eth";
        try resolver.resolve(DnsNameLib.encode(n), abi.encodeCall(IAddrResolver.addr, (_node(n)))) {
            revert("expected lookup");
        } catch (bytes memory err) {
            _expectMerkleLookup(err);
        }
        assertEq(_addr(n, BASE), abi.encodePacked(factory.computeOrgAddress(redCross)));
        assertEq(l2Lookups, 0);
    }

    function test_l2LookupUsesTheConfiguredGatewaysAndVerifierContext() public {
        bytes memory data = abi.encodeCall(IAddrResolver.addr, (bytes32(0)));
        try resolver.resolve(DnsNameLib.encode("american-red-cross.org.varada.eth"), data) {
            revert("expected lookup");
        } catch (bytes memory err) {
            assertEq(bytes4(err), OffchainLookup.selector);
            (address sender, string[] memory urls, bytes memory req, bytes4 cb,) =
                abi.decode(_tail(err), (address, string[], bytes, bytes4, bytes));
            assertEq(sender, address(resolver));
            assertEq(urls.length, 1);
            assertEq(urls[0], "https://optimism.gateway.unruggable.com");
            assertEq(cb, resolver.l2Callback.selector);
            (bytes memory ctx, GatewayRequest memory r) =
                abi.decode(_tail(req), (bytes, GatewayRequest));
            assertEq(ctx, mockVerifier.CONTEXT());
            assertEq(keccak256(r.ops), keccak256(resolver.l2Request(lhRed).ops));
        }
    }

    function test_slotConstantsMatchTheL2Registry() public {
        VaradaOrgNames reg = new VaradaOrgNames(owner, "");
        assertEq(resolver.L2_DEFAULT_IDS_SLOT(), reg.DEFAULT_IDS_SLOT());
        assertEq(resolver.L2_CHAIN_IDS_SLOT(), reg.CHAIN_IDS_SLOT());
        assertEq(bytes32(type(uint256).max), reg.NONE());
    }

    // ------------------------------------------------------------------ Merkle fallback

    function test_freshNameFallsBackToTheMerkleRoot() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes memory want = abi.encodePacked(factory.computeOrgAddress(redCross));
        assertEq(_addr(n, 60), want);
        assertEq(_addr(n, OP), want);
        assertEq(_addr(n, BASE), want);
        assertEq(l2Lookups, 3);
        assertEq(merkleLookups, 3);
    }

    function test_noDefaultAndNoOtherChains() public {
        string memory n = "american-red-cross.org.varada.eth";
        uint256[4] memory coins = [uint256(0x80000000), 0x80000000 | 42_161, 0x80000000 | 137, 0];
        for (uint256 i; i < 4; ++i) {
            assertEq(_addr(n, coins[i]).length, 0);
        }
    }

    function test_textRecords() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes32 node = _node(n);
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(ITextResolver.text, (node, "url"))), (string)),
            "https://varada.eth.limo/org/american-red-cross"
        );
        assertEq(
            abi.decode(
                _resolve(n, abi.encodeCall(ITextResolver.text, (node, "varada.orgId"))), (string)
            ),
            vm.toString(redCross)
        );
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(ITextResolver.text, (node, "avatar"))), (string)),
            ""
        );
    }

    function test_multicall() public {
        string memory n = "american-red-cross.org.varada.eth";
        bytes32 node = _node(n);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IAddressResolver.addr, (node, BASE));
        calls[1] = abi.encodeCall(ITextResolver.text, (node, "url"));
        calls[2] = abi.encodeWithSelector(bytes4(0xdeadbeef), node);
        bytes[] memory out =
            abi.decode(_resolve(n, abi.encodeWithSelector(bytes4(0xac9650d8), calls)), (bytes[]));
        assertEq(abi.decode(out[0], (bytes)), abi.encodePacked(factory.computeOrgAddress(redCross)));
        assertEq(abi.decode(out[1], (string)), "https://varada.eth.limo/org/american-red-cross");
        assertEq(out[2].length, 0);
    }

    function test_unknownLabelResolvesEmpty() public {
        string memory n = "nobody.org.varada.eth";
        assertEq(
            abi.decode(_resolve(n, abi.encodeCall(IAddrResolver.addr, (_node(n)))), (address)),
            address(0)
        );
    }

    function _carry(bytes32 lh, string memory label, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(lh, bytes(label), data);
    }

    function test_merkle_rejectsATamperedShard() public {
        bytes memory carry = _carry(lhRed, "american-red-cross", "");
        uint256 shard = ShardTree.shardOf(lhRed, BITS);
        VaradaOrgResolver.Entry[] memory es = ShardTree.entriesOf(mEntries, shard, BITS);
        bytes32[] memory p = ShardTree.proof(mEntries, shard, BITS);
        // The gateway repoints red cross at crossroads' org id, keeping the real proof.
        for (uint256 i; i < es.length; ++i) {
            if (es[i].labelhash == lhRed) es[i] = ShardTree.entry(lhRed, crossroads);
        }
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidProof.selector, shard));
        resolver.resolveCallback(abi.encode(merkleRoot, shard, es, p), carry);
        // Dropping red cross from its shard (to deny it exists) fails the same way.
        VaradaOrgResolver.Entry[] memory none = new VaradaOrgResolver.Entry[](0);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidProof.selector, shard));
        resolver.resolveCallback(abi.encode(merkleRoot, shard, none, p), carry);
    }

    function test_merkle_rejectsTheWrongShard() public {
        bytes memory carry = _carry(lhRed, "american-red-cross", "");
        uint256 shard = ShardTree.shardOf(lhRed, BITS);
        uint256 other = 1 - shard;
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.WrongShard.selector, shard, other));
        resolver.resolveCallback(ShardTree.answer(mEntries, other, BITS), carry);
    }

    function test_merkle_absentLabelIsProvablyEmpty() public view {
        bytes32 lh = keccak256("nobody");
        bytes memory out = resolver.resolveCallback(
            _answerFor(lh), _carry(lh, "nobody", abi.encodeCall(IAddrResolver.addr, (bytes32(0))))
        );
        assertEq(abi.decode(out, (address)), address(0));
    }

    function test_merkle_perChainIdsCannotBeDropped() public {
        // One-shard tree holding NPR with its Base override.
        VaradaOrgResolver.Entry[] memory all = new VaradaOrgResolver.Entry[](1);
        all[0] = VaradaOrgResolver.Entry(lhNpr, npr, npr, nprBase);
        VaradaOrgResolver single = _deploy(ShardTree.root(all, 0), 0);
        bytes32 node = _node("national-public-radio.org.varada.eth");
        bytes memory carry = _carry(
            lhNpr, "national-public-radio", abi.encodeCall(IAddressResolver.addr, (node, BASE))
        );
        bytes memory out = single.resolveCallback(ShardTree.answer(all, 0, 0), carry);
        assertEq(abi.decode(out, (bytes)), abi.encodePacked(factory.computeOrgAddress(nprBase)));
        VaradaOrgResolver.Entry[] memory dropped = new VaradaOrgResolver.Entry[](1);
        dropped[0] = ShardTree.entry(lhNpr, npr);
        bytes32 sr = single.root();
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidProof.selector, 0));
        single.resolveCallback(abi.encode(sr, uint256(0), dropped, new bytes32[](0)), carry);
    }

    function test_merkle_rejectsUnknownRoots() public {
        bytes memory carry = _carry(lhRed, "american-red-cross", "");
        bytes32 fake = keccak256("fake");
        uint256 shard = ShardTree.shardOf(lhRed, BITS);
        VaradaOrgResolver.Entry[] memory es = ShardTree.entriesOf(mEntries, shard, BITS);
        bytes32[] memory p = ShardTree.proof(mEntries, shard, BITS);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, fake));
        resolver.resolveCallback(abi.encode(fake, shard, es, p), carry);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, bytes32(0)));
        resolver.resolveCallback(abi.encode(bytes32(0), shard, es, p), carry);
    }

    function test_merkle_acceptsThePreviousRootAfterRotation() public {
        bytes32 old = merkleRoot;
        vm.prank(owner);
        resolver.setRoot(keccak256("next"), BITS);
        assertEq(resolver.previousRoot(), old);
        assertEq(
            _addr("american-red-cross.org.varada.eth", 60),
            abi.encodePacked(factory.computeOrgAddress(redCross))
        );
        vm.prank(owner);
        resolver.setRoot(keccak256("third"), BITS);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.UnknownRoot.selector, old));
        resolver.resolveCallback(_answerFor(lhRed), _carry(lhRed, "american-red-cross", ""));
    }

    function test_shardBitsAreBounded() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidShardBits.selector, 17));
        resolver.setRoot(keccak256("x"), 17);
        assertEq(resolver.shardBitsOf(merkleRoot), BITS);
        assertEq(resolver.shardOf(bytes32(type(uint256).max), 12), 4095);
        assertEq(resolver.shardOf(bytes32(type(uint256).max), 0), 0);
    }

    // ------------------------------------------------------------------ names and admin

    function test_namespaceDeeperAndForeignNamesAnswerEmptyWithoutLookup() public view {
        string[3] memory names = ["org.varada.eth", "a.b.org.varada.eth", "x.varada.eth"];
        for (uint256 i; i < 3; ++i) {
            bytes32 node = _node(names[i]);
            bytes memory r = resolver.resolve(
                DnsNameLib.encode(names[i]), abi.encodeCall(IAddrResolver.addr, (node))
            );
            assertEq(abi.decode(r, (address)), address(0));
            bytes memory c = resolver.resolve(
                DnsNameLib.encode(names[i]),
                abi.encodeCall(IContentHashResolver.contenthash, (node))
            );
            assertEq(abi.decode(c, (bytes)).length, 0);
        }
    }

    function test_unsupportedProfileReverts() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x12345678), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaradaOrgResolver.UnsupportedResolverProfile.selector, bytes4(0x12345678)
            )
        );
        resolver.resolve(DnsNameLib.encode("org.varada.eth"), data);
    }

    function test_malformedNameReverts() public {
        bytes memory bad = hex"40";
        vm.expectRevert(abi.encodeWithSelector(VaradaOrgResolver.InvalidDnsName.selector, bad));
        resolver.resolve(bad, abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
    }

    function test_adminIsOwnerOnly() public {
        address stranger = makeAddr("stranger");
        string[] memory urls = new string[](1);
        urls[0] = "https://evil";
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setRoot(bytes32(uint256(1)), BITS);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setGateways(urls);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setVerifier(IGatewayVerifier(address(1)), urls);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setSiteUrlPrefix("x");
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(VaradaOrgResolver.NoGateways.selector);
        resolver.setGateways(new string[](0));
        vm.expectRevert(VaradaOrgResolver.NoGateways.selector);
        resolver.setVerifier(mockVerifier, new string[](0));
        resolver.setVerifier(IGatewayVerifier(address(7)), urls);
        vm.stopPrank();
        assertEq(address(resolver.verifier()), address(7));
        assertEq(resolver.l2Gateways()[0], "https://evil");
    }

    function test_namespaceContenthashServesTheSwarmShards() public {
        bytes memory ch = abi.encodePacked(hex"e40101fa011b20", bytes32(uint256(0xe0f2)));
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        resolver.setNamespaceContenthash(ch);
        vm.prank(owner);
        resolver.setNamespaceContenthash(ch);
        bytes32 nsNode = _node("org.varada.eth");
        bytes memory r = resolver.resolve(
            DnsNameLib.encode("org.varada.eth"),
            abi.encodeCall(IContentHashResolver.contenthash, (nsNode))
        );
        assertEq(abi.decode(r, (bytes)), ch, "namespace answers the shard collection");
        // Children and other names keep an empty contenthash.
        bytes memory other = resolver.resolve(
            DnsNameLib.encode("x.varada.eth"),
            abi.encodeCall(IContentHashResolver.contenthash, (_node("x.varada.eth")))
        );
        assertEq(abi.decode(other, (bytes)).length, 0);
        bytes memory child = _resolve(
            "american-red-cross.org.varada.eth",
            abi.encodeCall(
                IContentHashResolver.contenthash, (_node("american-red-cross.org.varada.eth"))
            )
        );
        assertEq(abi.decode(child, (bytes)).length, 0);
    }

    function test_supportsExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(type(IExtendedResolver).interfaceId));
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
        assertFalse(resolver.supportsInterface(0xffffffff));
    }
}
