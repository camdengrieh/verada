// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {
    IAddrResolver,
    IAddressResolver,
    IContentHashResolver,
    IExtendedResolver,
    ITextResolver
} from "./interfaces/external/ens/IEnsResolverProfiles.sol";
import {LabelLib} from "./libraries/LabelLib.sol";

/// @title VaradaDonorNames
/// @notice `<name>.donor.varada.eth` for anyone, first come: an address claims one name for itself
///         and can release it. The contract is also the names' ENSIP-10 resolver, set on the `donor`
///         entry of varada.eth's ENSv2 registry. A name resolves to its holder's address on
///         Ethereum, Optimism and Base.
/// @dev Labels follow the coin rules (LabelLib: `[a-z0-9-]`, no leading/trailing hyphen, no `--` at
///      positions 3-4), with a minimum of 3 characters. The owner can only reserve or unreserve
///      unclaimed labels; it has no power over a claimed name. The address answer is the holder's
///      address, which is right for EOAs on every EVM chain. A smart-contract wallet whose
///      address differs per chain should not claim. There is deliberately no ENSIP-19 default for
///      other chains.
contract VaradaDonorNames is
    IExtendedResolver,
    IAddrResolver,
    IAddressResolver,
    ITextResolver,
    IContentHashResolver,
    IERC165,
    Ownable2Step
{
    uint256 public constant COIN_TYPE_ETH = 60;
    uint256 public constant COIN_TYPE_OPTIMISM = 0x80000000 | 10;
    uint256 public constant COIN_TYPE_BASE = 0x80000000 | 8453;
    uint256 public constant MIN_LENGTH = 3;

    /// @notice Namehash of `donor.varada.eth`.
    bytes32 public immutable namespaceNode;
    bytes32 internal immutable _namespaceDnsHash;
    uint256 internal immutable _namespaceDnsLength;

    mapping(bytes32 labelhash => address) public holderOf;
    mapping(bytes32 node => address) public holderOfNode;
    mapping(address => string) internal _nameOf;
    mapping(bytes32 labelhash => bool) public isReserved;

    event Claimed(bytes32 indexed labelhash, string label, address indexed holder);
    event Released(bytes32 indexed labelhash, string label, address indexed holder);
    event ReservationChanged(bytes32 indexed labelhash, bool reserved);

    error TooShort(string label);
    error Taken(string label, address holder);
    error Reserved(string label);
    error AlreadyHasName(address holder, string name);
    error NoName(address holder);
    error InvalidDnsName(bytes name);
    error UnsupportedResolverProfile(bytes4 selector);

    /// @param namespaceDnsName `\x05donor\x06varada\x03eth\x00`.
    /// @param namespaceNode_ namehash of `donor.varada.eth`.
    /// @param reserved labels no one may claim (e.g. org, coin, donor, agent, names, varada).
    constructor(
        address owner_,
        bytes memory namespaceDnsName,
        bytes32 namespaceNode_,
        string[] memory reserved
    ) Ownable(owner_) {
        _namespaceDnsHash = keccak256(namespaceDnsName);
        _namespaceDnsLength = namespaceDnsName.length;
        namespaceNode = namespaceNode_;
        for (uint256 i; i < reserved.length; ++i) {
            bytes32 lh = keccak256(bytes(reserved[i]));
            isReserved[lh] = true;
            emit ReservationChanged(lh, true);
        }
    }

    // ------------------------------------------------------------------ names

    /// @notice Claims `label` for the caller. Reverts if it is taken, reserved or invalid, or if the
    ///         caller already holds a name (release it first).
    function claim(string calldata label) external returns (bytes32 node) {
        if (bytes(label).length < MIN_LENGTH) revert TooShort(label);
        bytes32 lh = LabelLib.validate(label);
        address holder = holderOf[lh];
        if (holder != address(0)) revert Taken(label, holder);
        if (isReserved[lh]) revert Reserved(label);
        if (bytes(_nameOf[msg.sender]).length != 0) {
            revert AlreadyHasName(msg.sender, _nameOf[msg.sender]);
        }
        node = keccak256(abi.encodePacked(namespaceNode, lh));
        holderOf[lh] = msg.sender;
        holderOfNode[node] = msg.sender;
        _nameOf[msg.sender] = label;
        emit Claimed(lh, label, msg.sender);
    }

    /// @notice Releases the caller's name so anyone can claim it.
    function release() external {
        string memory label = _nameOf[msg.sender];
        if (bytes(label).length == 0) revert NoName(msg.sender);
        bytes32 lh = keccak256(bytes(label));
        delete holderOf[lh];
        delete holderOfNode[keccak256(abi.encodePacked(namespaceNode, lh))];
        delete _nameOf[msg.sender];
        emit Released(lh, label, msg.sender);
    }

    /// @notice The donor name label `holder` claimed (empty if none).
    function nameOf(address holder) external view returns (string memory) {
        return _nameOf[holder];
    }

    /// @notice Whether `label` can be claimed right now.
    function available(string calldata label) external view returns (bool) {
        if (bytes(label).length < MIN_LENGTH || !LabelLib.isValid(label)) return false;
        bytes32 lh = keccak256(bytes(label));
        return holderOf[lh] == address(0) && !isReserved[lh];
    }

    /// @notice Reserves or frees an unclaimed label.
    function setReserved(string calldata label, bool reserved) external onlyOwner {
        bytes32 lh = keccak256(bytes(label));
        if (reserved && holderOf[lh] != address(0)) revert Taken(label, holderOf[lh]);
        isReserved[lh] = reserved;
        emit ReservationChanged(lh, reserved);
    }

    // ------------------------------------------------------------------ ENSIP-10

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        return _answer(_holderOfName(name), data);
    }

    /// @inheritdoc IAddrResolver
    function addr(bytes32 node) external view returns (address payable) {
        return payable(holderOfNode[node]);
    }

    /// @inheritdoc IAddressResolver
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _coinAddress(holderOfNode[node], coinType);
    }

    /// @inheritdoc ITextResolver
    function text(bytes32, string calldata) external pure returns (string memory) {
        return "";
    }

    /// @inheritdoc IContentHashResolver
    function contenthash(bytes32) external pure returns (bytes memory) {
        return "";
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IExtendedResolver).interfaceId
            || interfaceId == type(IAddrResolver).interfaceId
            || interfaceId == type(IAddressResolver).interfaceId
            || interfaceId == type(ITextResolver).interfaceId
            || interfaceId == type(IContentHashResolver).interfaceId;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Holder of `<label>.donor.varada.eth`; zero for the namespace, deeper names and others.
    function _holderOfName(bytes calldata name) internal view returns (address) {
        if (name.length == 0) revert InvalidDnsName(name);
        uint256 len = uint8(name[0]);
        if (len == 0 || 1 + len >= name.length) return address(0);
        bytes calldata suffix = name[1 + len:];
        if (suffix.length != _namespaceDnsLength || keccak256(suffix) != _namespaceDnsHash) {
            return address(0);
        }
        return holderOf[keccak256(name[1:1 + len])];
    }

    function _answer(address holder, bytes memory data) internal view returns (bytes memory) {
        bytes4 selector = _selector(data);
        if (selector == IAddrResolver.addr.selector) return abi.encode(holder);
        if (selector == IAddressResolver.addr.selector) {
            (, uint256 coinType) = abi.decode(_args(data), (bytes32, uint256));
            return abi.encode(_coinAddress(holder, coinType));
        }
        if (selector == ITextResolver.text.selector) return abi.encode("");
        if (selector == IContentHashResolver.contenthash.selector) return abi.encode(bytes(""));
        if (selector == _MULTICALL) {
            bytes[] memory calls = abi.decode(_args(data), (bytes[]));
            bytes[] memory results = new bytes[](calls.length);
            for (uint256 i; i < calls.length; ++i) {
                bytes4 s = _selector(calls[i]);
                if (
                    s == IAddrResolver.addr.selector || s == IAddressResolver.addr.selector
                        || s == ITextResolver.text.selector
                        || s == IContentHashResolver.contenthash.selector
                ) results[i] = _answer(holder, calls[i]);
            }
            return abi.encode(results);
        }
        revert UnsupportedResolverProfile(selector);
    }

    bytes4 internal constant _MULTICALL = 0xac9650d8;

    function _coinAddress(address holder, uint256 coinType) internal pure returns (bytes memory) {
        if (holder == address(0)) return "";
        if (
            coinType == COIN_TYPE_ETH || coinType == COIN_TYPE_OPTIMISM
                || coinType == COIN_TYPE_BASE
        ) {
            return abi.encodePacked(holder);
        }
        return "";
    }

    function _selector(bytes memory data) internal pure returns (bytes4 s) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            s := mload(add(data, 32))
        }
    }

    function _args(bytes memory data) internal pure returns (bytes memory args) {
        uint256 n = data.length - 4;
        args = new bytes(n);
        assembly ("memory-safe") {
            mcopy(add(args, 32), add(data, 36), n)
        }
    }
}
