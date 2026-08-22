// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AttestationVerifier.sol";

contract AttestationVerifierTest is Test {
    AttestationVerifier public verifier;

    uint256 internal oraclePk = 0xA11CE;
    address internal oracle;

    address internal governance = makeAddr("governance");

    bytes32 internal constant MEASUREMENT = keccak256("aegis-enclave-build-v1");
    bytes32 internal constant DECISION = keccak256("REBALANCE_DECISION");

    function setUp() public {
        oracle = vm.addr(oraclePk);
        vm.prank(governance);
        verifier = new AttestationVerifier(oracle, MEASUREMENT);
        // Deterministic base timestamp so expiry arithmetic is readable.
        vm.warp(1_700_000_000);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// @dev Signs with an arbitrary key so tests can produce both valid and forged proofs.
    function _proof(uint256 signerPk, bytes32 decisionHash, bytes32 measurement, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = verifier.attestationDigest(decisionHash, measurement, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encode(measurement, expiry, abi.encodePacked(r, s, v));
    }

    function _validProof() internal view returns (bytes memory) {
        return _proof(oraclePk, DECISION, MEASUREMENT, uint64(block.timestamp + 300));
    }

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    function test_Verify_Success() public view {
        assertTrue(verifier.verify(DECISION, _validProof()));
    }

    function test_Verify_SucceedsExactlyAtExpiry() public view {
        // `block.timestamp > expiry` is the reject condition, so equality passes.
        bytes memory proof = _proof(oraclePk, DECISION, MEASUREMENT, uint64(block.timestamp));
        assertTrue(verifier.verify(DECISION, proof));
    }

    // -----------------------------------------------------------------------
    // Measurement binding — the property the previous verifier lacked entirely
    // -----------------------------------------------------------------------

    function test_Verify_Revert_WrongMeasurement() public {
        bytes32 rogue = keccak256("attacker-enclave-build");
        bytes memory proof = _proof(oraclePk, DECISION, rogue, uint64(block.timestamp + 300));

        vm.expectRevert(
            abi.encodeWithSelector(AttestationVerifier.MeasurementMismatch.selector, MEASUREMENT, rogue)
        );
        verifier.verify(DECISION, proof);
    }

    function testFuzz_Verify_Revert_AnyOtherMeasurement(bytes32 rogueMeasurement) public {
        vm.assume(rogueMeasurement != MEASUREMENT);
        bytes memory proof = _proof(oraclePk, DECISION, rogueMeasurement, uint64(block.timestamp + 300));

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestationVerifier.MeasurementMismatch.selector, MEASUREMENT, rogueMeasurement
            )
        );
        verifier.verify(DECISION, proof);
    }

    // -----------------------------------------------------------------------
    // Decision binding
    // -----------------------------------------------------------------------

    function test_Verify_Revert_SignatureForDifferentDecision() public {
        // Oracle signed decision A; caller submits it for decision B.
        bytes memory proof = _proof(oraclePk, keccak256("DECISION_A"), MEASUREMENT, uint64(block.timestamp + 300));

        // Recovery succeeds but yields an unrelated address, so the signer check fails.
        vm.expectRevert();
        verifier.verify(keccak256("DECISION_B"), proof);
    }

    // -----------------------------------------------------------------------
    // Signer binding
    // -----------------------------------------------------------------------

    function test_Verify_Revert_ForgedByNonOracle() public {
        uint256 attackerPk = 0xBAD;
        bytes memory proof = _proof(attackerPk, DECISION, MEASUREMENT, uint64(block.timestamp + 300));

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestationVerifier.UnauthorizedSigner.selector, vm.addr(attackerPk), oracle
            )
        );
        verifier.verify(DECISION, proof);
    }

    // -----------------------------------------------------------------------
    // Expiry
    // -----------------------------------------------------------------------

    function test_Verify_Revert_Expired() public {
        uint64 expiry = uint64(block.timestamp + 300);
        bytes memory proof = _proof(oraclePk, DECISION, MEASUREMENT, expiry);

        vm.warp(uint256(expiry) + 1);

        vm.expectRevert(
            abi.encodeWithSelector(AttestationVerifier.AttestationExpired.selector, expiry, block.timestamp)
        );
        verifier.verify(DECISION, proof);
    }

    // -----------------------------------------------------------------------
    // Cross-domain replay
    // -----------------------------------------------------------------------

    function test_Verify_Revert_SignatureFromOtherChain() public {
        // Oracle signs while the EVM reports chain 11155111...
        vm.chainId(11155111);
        bytes memory proof = _proof(oraclePk, DECISION, MEASUREMENT, uint64(block.timestamp + 300));

        // ...and the same bytes are replayed on chain 1.
        vm.chainId(1);
        vm.expectRevert();
        verifier.verify(DECISION, proof);
    }

    function test_Verify_Revert_SignatureFromOtherVerifier() public {
        bytes memory proof = _proof(oraclePk, DECISION, MEASUREMENT, uint64(block.timestamp + 300));

        // A second verifier with identical config must still reject it, because
        // address(this) is part of the signed statement.
        AttestationVerifier sibling = new AttestationVerifier(oracle, MEASUREMENT);
        vm.expectRevert();
        sibling.verify(DECISION, proof);
    }

    // -----------------------------------------------------------------------
    // Malformed input
    // -----------------------------------------------------------------------

    function test_Verify_Revert_ProofTooShort() public {
        vm.expectRevert(AttestationVerifier.MalformedProof.selector);
        verifier.verify(DECISION, hex"deadbeef");
    }

    function test_Verify_Revert_SignatureWrongLength() public {
        bytes memory proof = abi.encode(MEASUREMENT, uint64(block.timestamp + 300), hex"1234");
        vm.expectRevert(AttestationVerifier.MalformedSignature.selector);
        verifier.verify(DECISION, proof);
    }

    function test_Verify_Revert_MalleableSignature() public {
        uint64 expiry = uint64(block.timestamp + 300);
        bytes32 digest = verifier.attestationDigest(DECISION, MEASUREMENT, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);

        // Flip the signature into its malleable sibling: s' = n - s, v' = v ^ 1.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        bytes memory proof = abi.encode(MEASUREMENT, expiry, abi.encodePacked(r, flippedS, flippedV));
        vm.expectRevert(AttestationVerifier.MalformedSignature.selector);
        verifier.verify(DECISION, proof);
    }

    function test_Verify_Revert_InvalidV() public {
        uint64 expiry = uint64(block.timestamp + 300);
        bytes32 digest = verifier.attestationDigest(DECISION, MEASUREMENT, expiry);
        (, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);

        bytes memory proof = abi.encode(MEASUREMENT, expiry, abi.encodePacked(r, s, uint8(1)));
        vm.expectRevert(AttestationVerifier.MalformedSignature.selector);
        verifier.verify(DECISION, proof);
    }

    // -----------------------------------------------------------------------
    // Governance
    // -----------------------------------------------------------------------

    function test_Constructor_Revert_ZeroOracle() public {
        vm.expectRevert(AttestationVerifier.ZeroAddress.selector);
        new AttestationVerifier(address(0), MEASUREMENT);
    }

    function test_SetExpectedMeasurement_RotatesAndEmits() public {
        bytes32 next = keccak256("aegis-enclave-build-v2");

        vm.expectEmit(true, true, false, false, address(verifier));
        emit AttestationVerifier.ExpectedMeasurementUpdated(MEASUREMENT, next);

        vm.prank(governance);
        verifier.setExpectedMeasurement(next);

        assertEq(verifier.expectedMeasurement(), next);

        // The old build is now rejected, the new one accepted.
        bytes memory staleProof = _validProof();
        vm.expectRevert();
        verifier.verify(DECISION, staleProof);

        bytes memory newProof = _proof(oraclePk, DECISION, next, uint64(block.timestamp + 300));
        assertTrue(verifier.verify(DECISION, newProof));
    }

    function test_SetExpectedMeasurement_Revert_NotOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(AttestationVerifier.NotOwner.selector);
        verifier.setExpectedMeasurement(keccak256("nope"));
    }

    function test_TransferOwnership_ToZero_FreezesMeasurement() public {
        vm.prank(governance);
        verifier.transferOwnership(address(0));

        // Nobody can rotate the measurement any more — the enclave build is frozen.
        vm.prank(governance);
        vm.expectRevert(AttestationVerifier.NotOwner.selector);
        verifier.setExpectedMeasurement(keccak256("nope"));
    }
}
