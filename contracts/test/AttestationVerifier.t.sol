// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AttestationVerifier.sol";

contract AttestationVerifierTest is Test {
    AttestationVerifier public verifier;
    
    bytes32 public constant MOCK_MEASUREMENT = keccak256("MOCK_ENCLAVE_MEASUREMENT");
    
    function setUp() public {
        verifier = new AttestationVerifier(MOCK_MEASUREMENT);
    }

    function test_Verify_Success() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        
        // Mock proof simply ABI encodes reportDataHash (decisionHash) and measurementHash
        bytes memory proof = abi.encode(decisionHash, MOCK_MEASUREMENT);
        
        bool result = verifier.verify(decisionHash, proof);
        assertTrue(result);
    }

    function test_Verify_Revert_InvalidDecision() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes32 wrongDecisionHash = keccak256("WRONG_DECISION");
        
        bytes memory proof = abi.encode(wrongDecisionHash, MOCK_MEASUREMENT);
        
        vm.expectRevert("Invalid report data: does not match decision");
        verifier.verify(decisionHash, proof);
    }

    function test_Verify_Revert_InvalidMeasurement() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes32 wrongMeasurement = keccak256("WRONG_MEASUREMENT");
        
        bytes memory proof = abi.encode(decisionHash, wrongMeasurement);
        
        vm.expectRevert("Invalid measurement: enclave code mismatch");
        verifier.verify(decisionHash, proof);
    }
}
