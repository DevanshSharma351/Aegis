// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AttestationVerifier
 * @notice Verifies TEE attestation quotes for Aegis rebalance decisions.
 */
contract AttestationVerifier {
    /// @notice The expected measurement hash (e.g., MRTD for TDX or RTMR) of the trusted enclave build.
    bytes32 public immutable expectedMeasurement;

    /**
     * @notice Initializes the verifier with the measurement of the frozen enclave build.
     * @param _expectedMeasurement The measurement hash of the trusted TEE image.
     * 
     * TODO: For now, this uses a mock value during early integration. Once Workstream A
     * is completely frozen, this should be set to the real enclave measurement.
     */
    constructor(bytes32 _expectedMeasurement) {
        expectedMeasurement = _expectedMeasurement;
    }

    /**
     * @notice Verifies the attestation proof against a decision hash.
     * @param decisionHash The hash of the rebalance decision (allocations + rationale).
     * @param attestationProof The TEE quote proving the decision was generated in the enclave.
     * @return True if the proof is valid, reverts otherwise.
     *
     * @dev 
     * ============================================================================
     * WARNING: SIMPLIFIED VERIFIER FOR EARLY INTEGRATION
     * ============================================================================
     * This is a simplified verification path for testing purposes. It naively 
     * decodes the proof into a reportDataHash and a measurementHash and checks 
     * equality. 
     *
     * PRODUCTION REQUIREMENT:
     * Before mainnet deployment, this must be replaced with either:
     * (a) Full on-chain DCAP quote verification using a library like dcap-qvl.
     * (b) A relayed-verification pattern where an off-chain verifier's signature 
     *     is checked on-chain instead.
     * This choice must be made explicitly and documented.
     * ============================================================================
     */
    function verify(bytes32 decisionHash, bytes calldata attestationProof) external view returns (bool) {
        // Decode the mock proof
        (bytes32 reportDataHash, bytes32 measurementHash) = abi.decode(attestationProof, (bytes32, bytes32));

        require(reportDataHash == decisionHash, "Invalid report data: does not match decision");
        require(measurementHash == expectedMeasurement, "Invalid measurement: enclave code mismatch");

        return true;
    }
}
