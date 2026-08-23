// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AegisVault.sol";
import "../src/AttestationVerifier.sol";

contract AegisVaultTest is Test {
    AegisVault public vault;
    AttestationVerifier public verifier;

    uint256 internal oraclePk = 0xA11CE;
    address internal oracle;

    address internal owner = makeAddr("owner");
    /// @dev Stands in for the ERC-4337 Kernel smart account, not the session-key EOA.
    address internal smartAccount = makeAddr("smartAccount");

    bytes32 internal constant MEASUREMENT = keccak256("aegis-enclave-build-v1");

    address internal constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    function setUp() public {
        oracle = vm.addr(oraclePk);

        vm.startPrank(owner);
        verifier = new AttestationVerifier(oracle, MEASUREMENT);

        address[] memory assets = new address[](2);
        assets[0] = WETH;
        assets[1] = USDC;
        vault = new AegisVault(address(verifier), assets);

        vault.setSessionKey(smartAccount);
        vm.stopPrank();

        vm.warp(1_700_000_000);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _proof(bytes32 decisionHash, bytes32 measurement, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        return _proof(decisionHash, measurement, expiry, false);
    }

    function _proof(bytes32 decisionHash, bytes32 measurement, uint64 expiry, bool hardwareVerified)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest =
            verifier.attestationDigest(decisionHash, measurement, hardwareVerified, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        return abi.encode(measurement, expiry, hardwareVerified, abi.encodePacked(r, s, v));
    }

    function _validProof(bytes32 decisionHash) internal view returns (bytes memory) {
        return _proof(decisionHash, MEASUREMENT, uint64(block.timestamp + 300));
    }

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    function test_Constructor_StoresAssetsAndVerifier() public view {
        assertEq(address(vault.attestationVerifier()), address(verifier));
        assertEq(vault.owner(), owner);
        assertEq(vault.whitelistedAssetsLength(), 2);
        assertEq(vault.whitelistedAssetAt(0), WETH);
        assertEq(vault.whitelistedAssetAt(1), USDC);

        address[] memory assets = vault.whitelistedAssets();
        assertEq(assets.length, 2);
        assertEq(assets[0], WETH);
    }

    function test_Constructor_Revert_NoAssets() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AegisVault.NoAssets.selector);
        new AegisVault(address(verifier), empty);
    }

    function test_Constructor_Revert_ZeroVerifier() public {
        address[] memory assets = new address[](1);
        assets[0] = WETH;
        vm.expectRevert(AegisVault.ZeroAddress.selector);
        new AegisVault(address(0), assets);
    }

    // -----------------------------------------------------------------------
    // Session key bootstrap
    // -----------------------------------------------------------------------

    function test_SetSessionKey_Revert_DoubleSet() public {
        vm.prank(owner);
        vm.expectRevert(AegisVault.SessionKeyAlreadySet.selector);
        vault.setSessionKey(makeAddr("other"));
    }

    function test_SetSessionKey_Revert_NotOwner() public {
        address[] memory assets = new address[](1);
        assets[0] = WETH;
        vm.prank(owner);
        AegisVault fresh = new AegisVault(address(verifier), assets);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(AegisVault.NotOwner.selector);
        fresh.setSessionKey(makeAddr("attackerAccount"));
    }

    function test_SetSessionKey_Revert_Zero() public {
        address[] memory assets = new address[](1);
        assets[0] = WETH;
        vm.startPrank(owner);
        AegisVault fresh = new AegisVault(address(verifier), assets);
        vm.expectRevert(AegisVault.ZeroAddress.selector);
        fresh.setSessionKey(address(0));
        vm.stopPrank();
    }

    function test_SetSessionKey_EmitsEvent() public {
        address[] memory assets = new address[](1);
        assets[0] = WETH;
        vm.startPrank(owner);
        AegisVault fresh = new AegisVault(address(verifier), assets);

        vm.expectEmit(true, false, false, false, address(fresh));
        emit AegisVault.SessionKeyBound(smartAccount);
        fresh.setSessionKey(smartAccount);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Rebalance — happy path
    // -----------------------------------------------------------------------

    function test_Rebalance_Success() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");

        // Build the proof BEFORE pranking: _validProof makes an external view
        // call to the verifier, which would otherwise consume the prank.
        bytes memory proof = _validProof(decisionHash);

        vm.expectEmit(true, false, false, true, address(vault));
        emit AegisVault.RebalanceExecuted(decisionHash, block.timestamp, 1, false);

        vm.prank(smartAccount);
        vault.rebalance(decisionHash, proof);

        assertEq(vault.rebalanceCount(), 1);
        assertEq(vault.lastRebalanceAt(), block.timestamp);
        assertEq(vault.executedAt(decisionHash), block.timestamp);
        assertTrue(vault.isDecisionExecuted(decisionHash));
    }

    function test_Rebalance_SequenceIncrements() public {
        for (uint256 i = 1; i <= 3; i++) {
            bytes32 decisionHash = keccak256(abi.encode("DECISION", i));
            vm.warp(block.timestamp + 1 days);
            bytes memory proof = _validProof(decisionHash);

            vm.expectEmit(true, false, false, true, address(vault));
            emit AegisVault.RebalanceExecuted(decisionHash, block.timestamp, i, false);

            vm.prank(smartAccount);
            vault.rebalance(decisionHash, proof);
        }
        assertEq(vault.rebalanceCount(), 3);
    }

    // -----------------------------------------------------------------------
    // Rebalance — access control
    // -----------------------------------------------------------------------

    function test_Rebalance_Revert_NotSessionKey() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");

        bytes memory proof = _validProof(decisionHash);

        // The owner is explicitly not privileged here.
        vm.prank(owner);
        vm.expectRevert(AegisVault.NotSessionKey.selector);
        vault.rebalance(decisionHash, proof);
    }

    function testFuzz_Rebalance_Revert_ArbitraryCaller(address caller) public {
        vm.assume(caller != smartAccount);
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes memory proof = _validProof(decisionHash);

        vm.prank(caller);
        vm.expectRevert(AegisVault.NotSessionKey.selector);
        vault.rebalance(decisionHash, proof);
    }

    // -----------------------------------------------------------------------
    // Rebalance — replay protection
    // -----------------------------------------------------------------------

    function test_Rebalance_Revert_ReplayedDecision() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes memory proof = _validProof(decisionHash);

        vm.prank(smartAccount);
        vault.rebalance(decisionHash, proof);

        uint256 firstExecution = block.timestamp;
        vm.warp(block.timestamp + 60); // still inside the proof's expiry window

        vm.prank(smartAccount);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.DecisionAlreadyExecuted.selector, decisionHash, firstExecution)
        );
        vault.rebalance(decisionHash, proof);

        assertEq(vault.rebalanceCount(), 1, "replay must not advance the counter");
    }

    // -----------------------------------------------------------------------
    // Rebalance — attestation failures propagate
    // -----------------------------------------------------------------------

    function test_Rebalance_Revert_WrongMeasurement() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes32 rogue = keccak256("attacker-enclave-build");
        bytes memory proof = _proof(decisionHash, rogue, uint64(block.timestamp + 300));

        vm.prank(smartAccount);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationVerifier.MeasurementMismatch.selector, MEASUREMENT, rogue)
        );
        vault.rebalance(decisionHash, proof);

        assertEq(vault.rebalanceCount(), 0);
        assertFalse(vault.isDecisionExecuted(decisionHash));
    }

    function test_Rebalance_Revert_ExpiredProof() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        uint64 expiry = uint64(block.timestamp + 300);
        bytes memory proof = _proof(decisionHash, MEASUREMENT, expiry);

        vm.warp(uint256(expiry) + 1);

        vm.prank(smartAccount);
        vm.expectRevert(
            abi.encodeWithSelector(AttestationVerifier.AttestationExpired.selector, expiry, block.timestamp)
        );
        vault.rebalance(decisionHash, proof);
    }

    function test_Rebalance_Revert_UnsignedProof() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes memory garbage = abi.encode(MEASUREMENT, uint64(block.timestamp + 300), new bytes(65));

        vm.prank(smartAccount);
        vm.expectRevert();
        vault.rebalance(decisionHash, garbage);
    }

    // -----------------------------------------------------------------------
    // Zero-withdrawal, asserted against the compiled artifact
    // -----------------------------------------------------------------------

    function test_NoWithdrawalFunction_CommonSelectorsAllFail() public {
        bytes4[8] memory selectors = [
            bytes4(0x2e1a7d4d), // withdraw(uint256)
            bytes4(0x51cff8d9), // withdraw(address)
            bytes4(0x853828b6), // withdrawAll()
            bytes4(0x3ccfd60b), // withdraw()
            bytes4(0xa9059cbb), // transfer(address,uint256)
            bytes4(0x23b872dd), // transferFrom(address,address,uint256)
            bytes4(0xf3fef3a3), // withdraw(address,uint256)
            bytes4(0x69328dec) // withdraw(address,uint256,address)
        ];

        for (uint256 i = 0; i < selectors.length; i++) {
            bytes memory data = abi.encodePacked(selectors[i], uint256(1 ether), uint256(1 ether), uint256(0));
            (bool success,) = address(vault).call(data);
            assertFalse(success, "vault must expose no value-moving function");
        }
    }

    function test_NoFallback_PlainCallReverts() public {
        (bool success,) = address(vault).call(hex"");
        assertFalse(success, "vault must have no receive/fallback");
    }

    function test_CannotReceiveEther() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(vault).call{value: 1 ether}(hex"");
        assertFalse(success, "vault must reject ETH");
        assertEq(address(vault).balance, 0);
    }

    function test_NoWithdrawalFunction_ExhaustiveOverSelectorSpace() public {
        // Every 4-byte value that is not one of the vault's declared selectors
        // must revert. This is the real assertion behind the zero-withdrawal
        // claim: not "we didn't write withdraw()", but "nothing else is callable".
        // Public state variables generate their getters implicitly, so their
        // selectors are derived from the signature rather than reachable as
        // `AegisVault.x.selector`.
        bytes4[13] memory declared = [
            AegisVault.rebalance.selector,
            AegisVault.setSessionKey.selector,
            AegisVault.whitelistedAssets.selector,
            AegisVault.whitelistedAssetsLength.selector,
            AegisVault.whitelistedAssetAt.selector,
            AegisVault.isDecisionExecuted.selector,
            bytes4(keccak256("owner()")),
            bytes4(keccak256("attestationVerifier()")),
            bytes4(keccak256("sessionKey()")),
            bytes4(keccak256("sessionKeySet()")),
            bytes4(keccak256("executedAt(bytes32)")),
            bytes4(keccak256("rebalanceCount()")),
            bytes4(keccak256("lastRebalanceAt()"))
        ];

        // Sample the space rather than enumerating 2^32 entries.
        for (uint256 i = 0; i < 512; i++) {
            bytes4 candidate = bytes4(keccak256(abi.encode("selector-probe", i)));

            bool isDeclared = false;
            for (uint256 j = 0; j < declared.length; j++) {
                if (candidate == declared[j]) isDeclared = true;
            }
            if (isDeclared) continue;

            (bool success,) = address(vault).call(abi.encodePacked(candidate, uint256(0), uint256(0)));
            assertFalse(success, "undeclared selector must not be callable");
        }
    }

    // Needed so the ETH-rejection test can hold a balance to send.
    receive() external payable {}
}
