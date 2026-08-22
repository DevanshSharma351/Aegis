// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AttestationVerifier.sol";

/**
 * @title AegisVault
 * @notice The core vault for the Aegis protocol. Enforces TEE attestation 
 *         before allowing rebalance execution via a session key.
 */
contract AegisVault {
    address public immutable owner;
    AttestationVerifier public immutable attestationVerifier;
    
    // Whitelisted assets (e.g. WETH, USDC) hardcoded as constructor args
    address[] public whitelistedAssets;

    address public sessionKey;
    bool public sessionKeySet;

    event RebalanceExecuted(bytes32 indexed decisionHash, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlySessionKey() {
        require(msg.sender == sessionKey, "Not session key");
        _;
    }

    /**
     * @notice Initializes the vault with immutable parameters and whitelisted assets.
     * @param _verifier Address of the AttestationVerifier contract.
     * @param _assets Array of whitelisted asset addresses (e.g., WETH, USDC).
     */
    constructor(address _verifier, address[] memory _assets) {
        owner = msg.sender;
        attestationVerifier = AttestationVerifier(_verifier);
        whitelistedAssets = _assets;
    }

    /**
     * @notice Sets the Identity session key. Can only be called exactly once by the owner.
     * @param _sessionKey The address of the session key.
     */
    function setSessionKey(address _sessionKey) external onlyOwner {
        require(!sessionKeySet, "Session key already set");
        require(_sessionKey != address(0), "Invalid session key");
        
        sessionKey = _sessionKey;
        sessionKeySet = true;
    }

    /**
     * @notice Executes a rebalance based on a TEE-attested decision.
     * @param decisionHash The hash of the rebalance decision (allocations).
     * @param attestationProof The TEE quote proving the decision.
     */
    function rebalance(bytes32 decisionHash, bytes calldata attestationProof) external onlySessionKey {
        // Verify the TEE attestation proof
        // Reverts if the proof is invalid or doesn't match the decision hash.
        bool isValid = attestationVerifier.verify(decisionHash, attestationProof);
        require(isValid, "Attestation verification failed");

        // Execute the rebalance...
        // (In a full implementation, this would interact with a DEX router like Uniswap or Railgun via adapter)

        // Emit privacy-preserving event (no amounts/allocations)
        emit RebalanceExecuted(decisionHash, block.timestamp);
    }

    /**
     * @dev 
     * ============================================================================
     * SECURITY NOTE: ZERO-WITHDRAWAL POLICY
     * ============================================================================
     * There is deliberately no withdrawal function in this contract.
     * 
     * This ensures that funds cannot be extracted from the vault by any party, 
     * not even the owner or the session key. Security is enforced structurally 
     * as defense-in-depth, rather than relying purely on session-key policies.
     * All value remains within the whitelisted assets.
     * ============================================================================
     */
}
