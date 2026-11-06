// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {DeployLive} from "../../script/DeployLive.s.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IOutcomeVotingScheme, NO_WINNER} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite} from "../mocks/GovernanceMocks.sol";
import {MockAcl, MockFhevmExecutor, MockKmsVerifier, ZamaLocal} from "../mocks/ZamaMocks.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";

/// @notice The real `RotationGovernor` on the real `ZamaVotingScheme` (mock coprocessor), wired
///         with the live deployment's voting settings (`DeployLive._configureRotationVoting`):
///         two ballots per decrypted poll, read by the scheme from `RotationGovernor.minVoters`,
///         and a counted weight of 0.01% of the supply.
contract RotationZamaIntegrationTest is Test, DeployLive {
    bytes internal constant INPUT_PROOF = hex"01";

    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    MockAcl internal acl = MockAcl(ZamaLocal.ACL);
    ZamaVotingScheme internal zama;
    RotationGovernor internal gov;
    VeradaToken internal vt;
    bytes32[] internal causeIds;
    bytes32[] internal poolOrgs;
    bytes32[] internal poolLeaves;
    uint256 internal t0;

    address internal pm = makeAddr("poolManager");
    address internal alice = makeAddr("alice"); // 20%, the honest whale
    address internal bob = makeAddr("bob"); // 9%
    address internal attacker = makeAddr("attacker"); // one whole token
    address internal heavyAttacker = makeAddr("heavyAttacker"); // exactly the counted weight

    function setUp() public {
        vm.etch(ZamaLocal.EXECUTOR, type(MockFhevmExecutor).runtimeCode);
        vm.etch(ZamaLocal.ACL, type(MockAcl).runtimeCode);
        vm.etch(ZamaLocal.KMS_VERIFIER, type(MockKmsVerifier).runtimeCode);

        vm.warp(1_700_000_000);
        MockOrgFactory endFactory = new MockOrgFactory(
            new MockEndaomentRegistry(address(new MockUSDC()), makeAddr("endTreasury"))
        );
        CauseRegistry causes =
            new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(endFactory)));
        for (uint256 i; i < 3; ++i) {
            bytes32 orgId = bytes32(uint256(1000 + i));
            bytes32 id = causes.causeIdOf(orgId);
            causes.addCause(id, orgId, endFactory.computeOrgAddress(orgId), "");
            causeIds.push(id);
            poolOrgs.push(orgId);
        }
        CauseCatalog catalog = new CauseCatalog(address(this));
        poolLeaves = CatalogPublish.publish(catalog, poolOrgs);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        zama = new ZamaVotingScheme(address(this));
        gov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ICauseCatalog(address(catalog)),
            ITokenProfileRegistry(address(profiles)),
            pm,
            IOutcomeVotingScheme(address(zama)),
            defaultRotationParams()
        );
        _configureRotationVoting(zama, gov);
        causes.setMaterializer(address(gov), true);
        gov.setVault(address(this));

        vt = new VeradaToken("T", "T", "", address(this), address(this));
        uint256 unit = 1e9 * 1e18;
        vt.transfer(pm, 70 * unit);
        vt.transfer(alice, 20 * unit);
        vt.transfer(bob, 9 * unit);
        vt.transfer(attacker, 1e18);
        vt.transfer(heavyAttacker, uint256(ROTATION_MIN_COUNTED_WEIGHT) * 1e18);
        vm.warp(block.timestamp + 7 days);
        t0 = block.timestamp;
        profiles.setFocus(address(vt), CatalogPublish.CATEGORIES, CatalogPublish.REGIONS);
        gov.registerToken(address(vt), causeIds[0], RotationPeriod.OneDay);
        profiles.register(address(vt), makeAddr("controller"));

        // Round 2's vote window, ballot prepared (causes 0..2).
        vm.warp(t0 + 1 days + 10);
        gov.prepareRound(address(vt), 2, CatalogPublish.allDraws(poolOrgs, poolLeaves));
    }

    function _scope() internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_ROTATION, 2);
    }

    function _vote(address voter, uint8 choice) internal {
        bytes32 handle = keccak256(abi.encode("ballot", voter));
        executor.setInputValue(handle, choice);
        vm.prank(voter);
        zama.castBallot(address(gov), address(vt), _scope(), abi.encode(handle, INPUT_PROOF));
    }

    function _close() internal {
        (,, uint40 end,,,,) = gov.roundOf(address(vt), 2);
        vm.warp(end);
        gov.closeRound(address(vt), 2);
    }

    /// @dev Relays the mock coprocessor's plaintext of the outcome, if there is one to decrypt.
    function _submitIfPending() internal {
        bytes32 h = zama.outcomeHandle(address(gov), address(vt), _scope());
        if (h == bytes32(0)) return;
        zama.submitOutcome(
            address(gov),
            address(vt),
            _scope(),
            abi.encode(executor.valueOf(h)),
            abi.encodePacked(uint8(1), new bytes(65))
        );
    }

    function _status() internal view returns (IRotationGovernor.RoundStatus st, bytes32 winner) {
        (st,,,, winner,,) = gov.roundOf(address(vt), 2);
    }

    function test_deployedSettings() public view {
        assertEq(gov.minVoters(), 2);
        assertEq(zama.minCountedWeightOf(address(gov)), 10_000_000);
        assertTrue(zama.isGovernor(address(gov)));
    }

    /// @notice Audit finding 10 under the deployed settings: an attacker holding one token
    ///         casts a valid ballot next to the honest whale. The governor sees two ballots and
    ///         asks for the outcome, but the scheme counts one, so the round is final at once
    ///         with no winner and nothing is decrypted: the whale's choice stays hidden.
    function test_validOneTokenBallotDoesNotRevealTheWhale() public {
        _vote(alice, 1);
        _vote(attacker, 0);
        assertEq(zama.ballotCount(address(gov), address(vt), _scope()), 2);
        _close();

        (bool isFinal, uint8 winner) = zama.outcomeOf(address(gov), address(vt), _scope());
        assertTrue(isFinal);
        assertEq(winner, NO_WINNER);
        assertEq(zama.outcomeHandle(address(gov), address(vt), _scope()), bytes32(0));
        assertEq(acl.decryptableCount(), 0, "nothing decrypted");
        gov.finalizeRound(address(vt), 2);
        (IRotationGovernor.RoundStatus st,) = _status();
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.NoChange));
    }

    /// @notice The original form of the finding: a counted-weight ballot for a missing option.
    ///         It counts as a ballot in plaintext but not as a valid one, so the decrypted
    ///         outcome is no winner.
    function test_outOfRangeBallotDoesNotRevealTheWhale() public {
        _vote(alice, 1);
        _vote(heavyAttacker, 7);
        _close();
        bytes32 h = zama.outcomeHandle(address(gov), address(vt), _scope());
        assertTrue(h != bytes32(0), "two counted ballots: decrypted");
        assertEq(executor.valueOf(h), NO_WINNER, "the whale's choice was revealed");
        _submitIfPending();
        gov.finalizeRound(address(vt), 2);
        (IRotationGovernor.RoundStatus st,) = _status();
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.NoChange));
    }

    /// @notice Two counted ballots reveal the winner and the governor applies it; a light
    ///         ballot still adds its weight.
    function test_twoCountedBallotsApplyTheWinner() public {
        _vote(alice, 1);
        _vote(bob, 2);
        _vote(attacker, 0);
        _close();
        bytes32 h = zama.outcomeHandle(address(gov), address(vt), _scope());
        assertEq(executor.valueOf(h), 1);
        _submitIfPending();
        gov.finalizeRound(address(vt), 2);
        (IRotationGovernor.RoundStatus st, bytes32 winner) = _status();
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Applied));
        assertEq(winner, causeIds[1]);
    }

    /// @notice The scheme reads the governor's current `minVoters`: raised to three, two
    ///         counted ballots and a light one are not enough.
    function test_schemeReadsTheGovernorsMinVoters() public {
        gov.setMinVoters(3);
        _vote(alice, 1);
        _vote(bob, 2);
        _vote(attacker, 0);
        _close();
        (bool isFinal, uint8 winner) = zama.outcomeOf(address(gov), address(vt), _scope());
        assertTrue(isFinal);
        assertEq(winner, NO_WINNER);
        assertEq(acl.decryptableCount(), 0);
    }
}
