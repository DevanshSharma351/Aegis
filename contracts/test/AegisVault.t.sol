// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AegisVault.sol";
import "../src/AttestationVerifier.sol";

contract AegisVaultTest is Test {
    AegisVault public vault;
    AttestationVerifier public verifier;
    
    address public owner = address(1);
    address public sessionKey = address(2);
    
    bytes32 public constant MOCK_MEASUREMENT = keccak256("MOCK_ENCLAVE_MEASUREMENT");
    
    // Setup event to test emission
    event RebalanceExecuted(bytes32 indexed decisionHash, uint256 timestamp);

    function setUp() public {
        vm.startPrank(owner);
        verifier = new AttestationVerifier(MOCK_MEASUREMENT);
        
        address[] memory assets = new address[](2);
        assets[0] = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // WETH Sepolia
        assets[1] = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; // USDC Sepolia
        
        vault = new AegisVault(address(verifier), assets);
        
        // Initial configuration: set the session key
        vault.setSessionKey(sessionKey);
        vm.stopPrank();
    }

    function test_SetSessionKey_Revert_DoubleSet() public {
        vm.prank(owner);
        vm.expectRevert("Session key already set");
        vault.setSessionKey(address(3));
    }

    function test_SetSessionKey_Revert_NotOwner() public {
        vm.prank(address(4));
        vm.expectRevert("Not owner");
        vault.setSessionKey(address(3));
    }

    function test_Rebalance_Success() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes memory proof = abi.encode(decisionHash, MOCK_MEASUREMENT);
        
        // Fast forward time to test timestamp emission
        vm.warp(1600000000);
        
        vm.expectEmit(true, false, false, true, address(vault));
        emit RebalanceExecuted(decisionHash, 1600000000);
        
        vm.prank(sessionKey);
        vault.rebalance(decisionHash, proof);
    }

    function test_Rebalance_Revert_InvalidMeasurement() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes32 wrongMeasurement = keccak256("WRONG_MEASUREMENT");
        bytes memory proof = abi.encode(decisionHash, wrongMeasurement);
        
        vm.prank(sessionKey);
        vm.expectRevert("Invalid measurement: enclave code mismatch");
        vault.rebalance(decisionHash, proof);
    }
    
    function test_Rebalance_Revert_NotSessionKey() public {
        bytes32 decisionHash = keccak256("REBALANCE_DECISION");
        bytes memory proof = abi.encode(decisionHash, MOCK_MEASUREMENT);
        
        vm.prank(owner); // Owner cannot rebalance, only the session key
        vm.expectRevert("Not session key");
        vault.rebalance(decisionHash, proof);
    }

    function test_NoWithdrawalFunction_Safety() public {
        // Attempt to call common withdrawal selectors on the vault
        // withdraw(uint256) -> 0x2e1a7d4d
        // withdraw(address,uint256) -> 0x51cff8d9
        // withdrawAll() -> 0x853828b6
        // transfer(address,uint256) -> 0xa9059cbb

        bytes4[4] memory selectors = [
            bytes4(0x2e1a7d4d),
            bytes4(0x51cff8d9),
            bytes4(0x853828b6),
            bytes4(0xa9059cbb)
        ];

        for(uint i = 0; i < selectors.length; i++) {
            // Encode a call to the selector with generic 256-bit zero paddings
            bytes memory data = abi.encodePacked(selectors[i], uint256(1 ether), uint256(1 ether));
            
            (bool success, ) = address(vault).call(data);
            
            // Expected to fail because the functions do not exist (fallback/receive also don't exist)
            assertFalse(success, "Contract should not accept withdrawal calls");
        }
    }

    function testFuzz_Rebalance_Revert_InvalidProofs(bytes32 fuzzDecision, bytes32 fuzzMeasurement) public {
        // Assume the randomized measurement is not the valid one.
        // It's cryptographically impossible to guess it, but we satisfy Foundry's assume just in case.
        vm.assume(fuzzMeasurement != MOCK_MEASUREMENT);

        bytes memory fakeProof = abi.encode(fuzzDecision, fuzzMeasurement);
        
        vm.prank(sessionKey);
        vm.expectRevert("Invalid measurement: enclave code mismatch");
        vault.rebalance(fuzzDecision, fakeProof);
    }
}
