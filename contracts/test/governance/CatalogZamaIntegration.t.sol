// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BallotLog} from "../utils/BallotLog.sol";

import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ICauseCatalog} from "../../src/interfaces/ICauseCatalog.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {MockEndaomentRegistry, MockOrgFactory, MockUSDC} from "../mocks/EndaomentMocks.sol";
import {MockProfileRegistryLite} from "../mocks/GovernanceMocks.sol";
import {MockAcl, MockFhevmExecutor, MockKmsVerifier, ZamaLocal} from "../mocks/ZamaMocks.sol";
import {CatalogFixture} from "../utils/CatalogFixture.sol";
import {ColdGas} from "../utils/ColdGas.sol";
import {EagerTallyScheme} from "../utils/EagerTallyScheme.sol";

/// @notice A 32-option catalogue ballot voted with encrypted choices on the real
///         `ZamaVotingScheme` (packed tallies), decrypted through the plaintext-shadowing mock
///         coprocessor, finalized and materialized.
contract CatalogZamaIntegrationTest is BallotLog, ColdGas {
    MockFhevmExecutor internal executor = MockFhevmExecutor(ZamaLocal.EXECUTOR);
    /// @dev The production scheme; `preallocate` is only used to measure the eager baseline.
    EagerTallyScheme internal zama;
    EpochGovernor internal gov;
    CauseRegistry internal registry;
    MockOrgFactory internal orgFactory;
    CatalogFixture internal cat;
    VaradaToken internal tokenContract;
    address internal token;
    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address[5] internal voters;

    function setUp() public {
        _recordBallots();
        vm.etch(ZamaLocal.EXECUTOR, type(MockFhevmExecutor).runtimeCode);
        vm.etch(ZamaLocal.ACL, type(MockAcl).runtimeCode);
        vm.etch(ZamaLocal.KMS_VERIFIER, type(MockKmsVerifier).runtimeCode);

        vm.warp(1_750_000_123);
        tokenContract =
            new VaradaToken("Varada Test", "VTEST", "ipfs://meta", makeAddr("c"), factory);
        token = address(tokenContract);
        for (uint256 i; i < voters.length; ++i) {
            voters[i] = address(uint160(0x5000 + i));
            vm.prank(factory);
            tokenContract.transfer(voters[i], (i + 1) * 1_000_000e18);
        }
        vm.warp(block.timestamp + 7 days);

        MockUSDC usdc = new MockUSDC();
        orgFactory =
            new MockOrgFactory(new MockEndaomentRegistry(address(usdc), makeAddr("treasury")));
        registry = new CauseRegistry(owner, IEndaomentOrgFundFactory(address(orgFactory)));
        zama = new EagerTallyScheme(owner);
        MockProfileRegistryLite profiles = new MockProfileRegistryLite();
        cat = new CatalogFixture();
        for (uint256 i; i < 40; ++i) {
            cat.add(cat.bucketOf(2, 0), keccak256(abi.encode("org", i)));
        }
        cat.publish();
        gov = new EpochGovernor(
            owner,
            registry,
            ICauseCatalog(address(cat.catalog())),
            IVotingScheme(address(zama)),
            ITokenProfileRegistry(address(profiles))
        );
        profiles.register(token, makeAddr("c"));
        profiles.setFocus(token, uint64(1) << 2, uint16(1));
        vm.startPrank(owner);
        zama.setGovernor(address(gov), true);
        gov.setFactory(factory);
        registry.setMaterializer(address(gov), true);
        vm.stopPrank();
        vm.prank(factory);
        gov.registerToken(token);
        vm.warp(gov.epochStart(1));
    }

    function test_thirtyTwoOptionEncryptedBallot_endToEnd() public {
        assertEq(gov.ballotSize(), 32);
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, uint64(1) << 2, 1);
        gov.prepareBallot(token, 1, d);
        bytes32[] memory opts = _options(address(gov), token, 1);
        assertEq(opts.length, 32);
        assertEq(zama.optionCountOf(address(gov), token, 1), 32);
        // Lazy tallies: preparing the ballot creates no encrypted word.
        assertEq(zama.tallyHandles(address(gov), token, 1).length, 0);

        // Voters weigh 1M..5M whole tokens; options 31 (weights 1M + 4M) and 17 (5M) tie at 5M,
        // and 3 gets 2M + 3M = 5M as well. Ties go to the lowest index: option 3.
        uint8[5] memory choices = [31, 3, 3, 31, 17];
        for (uint256 i; i < voters.length; ++i) {
            bytes32 handle = keccak256(abi.encode("in", i));
            executor.setInputValue(handle, choices[i]);
            vm.prank(voters[i]);
            zama.castBallot(address(gov), token, 1, abi.encode(handle, hex"01"));
        }

        assertEq(zama.tallyHandles(address(gov), token, 1).length, 11);

        vm.warp(gov.epochStart(2));
        gov.closeEpoch(token, 1);
        bytes32[] memory words = zama.tallyHandles(address(gov), token, 1);
        bytes memory cleartexts;
        for (uint256 j; j < words.length; ++j) {
            cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
        }
        zama.submitTally(
            address(gov), token, 1, cleartexts, abi.encodePacked(uint8(1), new bytes(65))
        );
        gov.finalizeEpoch(token, 1, _orgIds(address(gov), token, 1));

        assertEq(gov.tally(token, 1, opts[31]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[3]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[17]), 5_000_000);
        assertEq(gov.tally(token, 1, opts[0]), 0);
        assertEq(gov.winningCause(token, 1), opts[3]);
        assertTrue(registry.isActive(opts[3]));
        assertEq(
            registry.getCause(opts[3]).orgAddress,
            orgFactory.computeOrgAddress(_orgIds(address(gov), token, 1)[3])
        );
    }

    /// @dev Token-chosen ballot sizes on the real scheme: `ceil(n / 3)` packed tally words, each
    ///      ballot updates every word, and the vote is tallied and finalized against the option
    ///      count the epoch was prepared with. Logs a steady-state ballot's gas per size.
    function test_chosenBallotSizes_endToEnd_andBallotGas() public {
        uint8[6] memory sizes = [2, 3, 8, 16, 30, 32];
        uint256[6] memory gasBySize;
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < sizes.length; ++i) {
            vm.revertToState(snap);
            uint8 n = sizes[i];
            vm.prank(makeAddr("c"));
            gov.setBallotSize(token, n);
            assertEq(gov.ballotSizeFor(token, 1), n);
            gov.prepareBallot(token, 1, cat.draws(gov, registry, token, 1, uint64(1) << 2, 1));
            bytes32[] memory opts = _options(address(gov), token, 1);
            assertEq(opts.length, n);
            assertEq(zama.optionCountOf(address(gov), token, 1), n);

            // The first ballot creates the words; the second is a typical voter's cost.
            for (uint256 v; v < 2; ++v) {
                bytes32 handle = keccak256(abi.encode("in", n, v));
                executor.setInputValue(handle, n - 1);
                bytes memory ballot = abi.encode(handle, hex"01");
                vm.prank(voters[v]);
                uint256 g = gasleft();
                zama.castBallot(address(gov), token, 1, ballot);
                gasBySize[i] = g - gasleft();
            }
            emit log_named_uint(
                string.concat("castBallot gas, ", vm.toString(n), " options"), gasBySize[i]
            );
            bytes32[] memory words = zama.tallyHandles(address(gov), token, 1);
            assertEq(words.length, (uint256(n) + 2) / 3);

            // Lowering the size mid-epoch changes nothing for this epoch.
            vm.prank(owner);
            gov.setBallotSizeCap(2);
            vm.warp(gov.epochStart(2));
            gov.closeEpoch(token, 1);
            bytes memory cleartexts;
            for (uint256 j; j < words.length; ++j) {
                cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
            }
            zama.submitTally(
                address(gov), token, 1, cleartexts, abi.encodePacked(uint8(1), new bytes(65))
            );
            gov.finalizeEpoch(token, 1, _orgIds(address(gov), token, 1));
            assertEq(gov.winningCause(token, 1), opts[n - 1]);
            assertEq(gov.tally(token, 1, opts[n - 1]), 3_000_000);
        }
        // One word for 2 or 3 options (the same cost), eleven for 32. The mocked coprocessor
        // charges more per word than the live one (about 86k gas per word on a mainnet fork).
        assertApproxEqAbs(gasBySize[0], gasBySize[1], 1000);
        assertLt(gasBySize[1], gasBySize[2]);
        assertLt(gasBySize[2], gasBySize[3]);
        assertLt(gasBySize[3], gasBySize[4]);
        assertLt(gasBySize[4], gasBySize[5]);
        emit log_named_uint("gas per tally word, mocked (30 -> 32)", gasBySize[5] - gasBySize[4]);
    }

    function test_gas_castBallot_thirtyTwoOptions() public {
        gov.prepareBallot(token, 1, cat.draws(gov, registry, token, 1, uint64(1) << 2, 1));
        bytes32 handle = keccak256("in");
        executor.setInputValue(handle, 5);
        bytes memory ballot = abi.encode(handle, hex"01");
        vm.prank(voters[0]);
        uint256 before = gasleft();
        zama.castBallot(address(gov), token, 1, ballot);
        emit log_named_uint("castBallot gas, 32 options (mocked coprocessor)", before - gasleft());
    }

    // ---- weekly platform cost: eager tallies (the old `open`) vs lazy tallies

    /// @dev Gas of one token-week's platform transactions on a 32-option catalogue ballot, as the
    ///      keeper sends them: `prepareBallot` and `finalizeEpoch`, plus `closeEpoch` and
    ///      `submitTally` when the epoch has ballots (the keeper never closes a ballot-less epoch).
    ///      Every transaction starts from cold accounts (`ColdGas`). Execution gas only: the
    ///      21k base and the calldata (draw proofs, KMS proof) are the same in both modes. Eager
    ///      replays the old `open` with `preallocate` right after the prepare. Mocked coprocessor:
    ///      the live figures are in `test/fork/ZamaScheme.t.sol`.
    function test_gas_weeklyPlatform_eagerVsLazyTallies() public {
        bytes32 org = keccak256("default-org");
        bytes32 fallbackCause = registry.causeIdOf(org);
        vm.startPrank(owner);
        registry.addCause(fallbackCause, org, orgFactory.computeOrgAddress(org), "");
        gov.setDefaultCause(fallbackCause);
        vm.stopPrank();

        // The accounts a token-week touches, cooled before every measured transaction.
        _coldSet = [
            address(gov),
            address(zama),
            address(registry),
            address(cat.catalog()),
            address(orgFactory),
            token,
            ZamaLocal.EXECUTOR,
            ZamaLocal.ACL,
            ZamaLocal.KMS_VERIFIER
        ];
        string[3] memory names = ["idle", "traded, no votes", "traded and voted"];
        uint256 snap = vm.snapshotState();
        for (uint256 k; k < 3; ++k) {
            uint256[2] memory platform;
            uint256[2] memory firstBallot;
            for (uint256 m; m < 2; ++m) {
                vm.revertToState(snap);
                (platform[m], firstBallot[m]) = _week(m == 0, k >= 1, k == 2 ? 3 : 0);
            }
            emit log_string(names[k]);
            emit log_named_uint("  platform gas / token-week, before (eager tallies)", platform[0]);
            emit log_named_uint("  platform gas / token-week, after (lazy tallies)", platform[1]);
            if (k == 2) {
                emit log_named_uint("  first castBallot gas, before", firstBallot[0]);
                emit log_named_uint("  first castBallot gas, after", firstBallot[1]);
            }
            assertLt(platform[1], platform[0], "lazy tallies must not cost the platform more");
        }
    }

    /// @dev Runs epoch 1 of `token` and returns the platform gas and the first ballot's gas.
    function _week(bool eager, bool traded, uint256 ballots)
        internal
        returns (uint256 platform, uint256 firstBallot)
    {
        IEpochGovernor.Draw[] memory d = cat.draws(gov, registry, token, 1, uint64(1) << 2, 1);
        _cool();
        uint256 g = gasleft();
        gov.prepareBallot(token, 1, d);
        if (eager) zama.preallocate(address(gov), token, 1);
        platform = g - gasleft();
        bytes32[] memory orgIds = _orgIds(address(gov), token, 1);

        if (traded) {
            vm.prank(voters[4]);
            tokenContract.transfer(voters[3], 1e18);
        }
        for (uint256 i; i < ballots; ++i) {
            bytes32 handle = keccak256(abi.encode("week", i));
            executor.setInputValue(handle, uint8(i * 7));
            bytes memory ballot = abi.encode(handle, hex"01");
            _cool();
            vm.prank(voters[i]);
            g = gasleft();
            zama.castBallot(address(gov), token, 1, ballot);
            if (i == 0) firstBallot = g - gasleft();
        }

        vm.warp(gov.epochStart(2));
        if (ballots != 0) {
            _cool();
            g = gasleft();
            gov.closeEpoch(token, 1);
            platform += g - gasleft();
            bytes32[] memory words = zama.tallyHandles(address(gov), token, 1);
            bytes memory cleartexts;
            for (uint256 j; j < words.length; ++j) {
                cleartexts = bytes.concat(cleartexts, abi.encode(executor.valueOf(words[j])));
            }
            bytes memory proof = abi.encodePacked(uint8(1), new bytes(65));
            _cool();
            g = gasleft();
            zama.submitTally(address(gov), token, 1, cleartexts, proof);
            platform += g - gasleft();
        }
        _cool();
        g = gasleft();
        gov.finalizeEpoch(token, 1, orgIds);
        platform += g - gasleft();
        assertTrue(gov.isFinalized(token, 1));
    }
}
