// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AttestationVerifier.sol";

/**
 * @title AegisVault
 * @notice On-chain execution log for the Aegis autonomous rebalancing agent.
 *
 * @dev The vault records that an attested rebalance decision was made. It
 *      deliberately records nothing about *what* was rebalanced — see the note on
 *      `RebalanceExecuted` — and it deliberately cannot move funds at all — see
 *      the note at the bottom of this file.
 *
 *      Trust flow for a single rebalance:
 *
 *        enclave  → produces decision, binds keccak(decision) into a TDX quote
 *        oracle   → verifies the quote off-chain, signs (decisionHash, measurement)
 *        session  → ERC-4337 UserOperation calls rebalance() from the smart account
 *        vault    → checks caller, checks replay, delegates proof check to verifier
 */
contract AegisVault {
    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner();
    error NotSessionKey();
    error SessionKeyAlreadySet();
    error ZeroAddress();
    error NoAssets();
    error DecisionAlreadyExecuted(bytes32 decisionHash, uint256 executedAt);

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /**
     * @notice Emitted once per successfully attested rebalance.
     *
     * @dev PRIVACY CONSTRAINT: this event carries the decision hash and a
     *      timestamp, and nothing else. No allocations, no amounts, no asset
     *      identifiers. An observer learns *that* the agent acted and *when*, and
     *      can verify the decision was attested — but learns nothing about the
     *      position. The actual asset movement happens through Railgun's shielded
     *      pool, so there is no public counterpart to correlate against.
     *
     *      `sequence` is included so a frontend can detect gaps without needing an
     *      archival log range query.
     */
    event RebalanceExecuted(bytes32 indexed decisionHash, uint256 timestamp, uint256 sequence);

    event SessionKeyBound(address indexed sessionKey);

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public immutable owner;
    AttestationVerifier public immutable attestationVerifier;

    /// @notice Assets the agent is permitted to hold. Fixed at deploy time.
    address[] private _whitelistedAssets;

    /**
     * @notice The ERC-4337 smart account authorised to submit rebalances.
     *
     * @dev IMPORTANT — this is the *smart account* address, not the session key
     *      EOA. A UserOperation executes with `msg.sender == account`, so the EOA
     *      that signs the operation never appears as the caller here. The session
     *      key's constraints (target, selector, zero value, rate limit) are
     *      enforced by the Kernel permission validator at `validateUserOp` time;
     *      this address is the second, on-chain half of the same restriction.
     *
     *      Binding the EOA here instead would make every rebalance revert.
     */
    address public sessionKey;
    bool public sessionKeySet;

    /// @notice Block timestamp at which a given decision hash was executed (0 = never).
    mapping(bytes32 => uint256) public executedAt;

    /// @notice Monotonic count of executed rebalances.
    uint256 public rebalanceCount;

    /// @notice Timestamp of the most recent rebalance (0 if none).
    uint256 public lastRebalanceAt;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(address _verifier, address[] memory assets) {
        if (_verifier == address(0)) revert ZeroAddress();
        if (assets.length == 0) revert NoAssets();

        owner = msg.sender;
        attestationVerifier = AttestationVerifier(_verifier);

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) revert ZeroAddress();
            _whitelistedAssets.push(assets[i]);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // -----------------------------------------------------------------------
    // Bootstrap
    // -----------------------------------------------------------------------

    /**
     * @notice Bind the executing smart account. Callable exactly once, by the owner.
     *
     * @dev This closes the circular dependency between this contract and the
     *      session key: the key's permission policy must name this vault as its
     *      only target, so the vault must exist first; the vault must know the
     *      account, so the account must exist before this call. Deploy vault →
     *      derive account → bind here.
     *
     *      One-shot by design: without that, `owner` could redirect execution
     *      rights to an arbitrary account at any time, and the bootstrap path
     *      would double as a permanent backdoor.
     */
    function setSessionKey(address _sessionKey) external onlyOwner {
        if (sessionKeySet) revert SessionKeyAlreadySet();
        if (_sessionKey == address(0)) revert ZeroAddress();

        sessionKey = _sessionKey;
        sessionKeySet = true;
        emit SessionKeyBound(_sessionKey);
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    /**
     * @notice Record an attested rebalance decision.
     * @param decisionHash keccak256 of the canonical decision JSON produced in the enclave.
     * @param attestationProof Oracle-signed proof; see AttestationVerifier.verify.
     */
    function rebalance(bytes32 decisionHash, bytes calldata attestationProof) external {
        if (msg.sender != sessionKey) revert NotSessionKey();

        // Replay guard. The verifier's signature is stateless and its expiry
        // window is measured in minutes, so without this the same decision could
        // be submitted repeatedly inside that window.
        uint256 previous = executedAt[decisionHash];
        if (previous != 0) revert DecisionAlreadyExecuted(decisionHash, previous);

        // Reverts with a specific error if the proof is expired, names the wrong
        // enclave measurement, or was not signed by the oracle.
        attestationVerifier.verify(decisionHash, attestationProof);

        executedAt[decisionHash] = block.timestamp;
        lastRebalanceAt = block.timestamp;
        uint256 sequence = ++rebalanceCount;

        emit RebalanceExecuted(decisionHash, block.timestamp, sequence);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function whitelistedAssets() external view returns (address[] memory) {
        return _whitelistedAssets;
    }

    function whitelistedAssetsLength() external view returns (uint256) {
        return _whitelistedAssets.length;
    }

    function whitelistedAssetAt(uint256 index) external view returns (address) {
        return _whitelistedAssets[index];
    }

    function isDecisionExecuted(bytes32 decisionHash) external view returns (bool) {
        return executedAt[decisionHash] != 0;
    }

    // -----------------------------------------------------------------------
    // SECURITY NOTE — ZERO-WITHDRAWAL BY CONSTRUCTION
    // -----------------------------------------------------------------------
    // There is no withdrawal function, no token-transfer function, no `receive`,
    // no `fallback`, and no delegatecall anywhere in this contract.
    //
    // This is structural, not policy. Session-key permissions are enforced by an
    // off-chain SDK and an on-chain validator module; both are code that can have
    // bugs. A missing function cannot have a bug. Even a fully compromised owner
    // key and a fully compromised session key cannot extract value here, because
    // there is no code path that moves value.
    //
    // The contract also cannot receive ETH: with no payable function and no
    // `receive`, any plain transfer reverts. `AegisVault.t.sol` asserts all of
    // this against the compiled artifact rather than trusting this comment.
    // -----------------------------------------------------------------------
}
