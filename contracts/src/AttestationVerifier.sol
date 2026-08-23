// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AttestationVerifier
 * @notice Verifies that a rebalance decision was produced by a known enclave build
 *         running inside a genuine TEE.
 *
 * @dev VERIFICATION MODEL — READ BEFORE DEPLOYING ANYWHERE THAT HOLDS VALUE
 *
 *      Aegis uses the *relayed verification* pattern (option (b) of the two paths
 *      described in the original design note). The full Intel TDX DCAP quote is
 *      verified OFF-chain by the Aegis attestation oracle, which then signs a
 *      compact statement that this contract checks on-chain.
 *
 *      Verifying a raw DCAP quote on-chain (option (a), e.g. via dcap-qvl) costs
 *      millions of gas and requires on-chain Intel PCS collateral, so it is out of
 *      scope for this deployment. The trade-off is explicit and bounded:
 *
 *        - The oracle CANNOT forge a decision the enclave did not make without
 *          also controlling the enclave, because the decision hash is bound into
 *          the TDX quote's report_data field, which the oracle checks.
 *        - The oracle CAN, if compromised, sign a statement naming a measurement
 *          that no real enclave produced. That is the residual trust assumption.
 *          It is removed by migrating `verify` to on-chain DCAP verification.
 *
 *      What this contract enforces on-chain:
 *        1. The signature recovers to the configured `oracleSigner`.
 *        2. The signed statement covers `decisionHash` — so a signature for one
 *           decision cannot be reused for another.
 *        3. The signed statement covers `measurement`, and that measurement must
 *           equal `expectedMeasurement` — so a decision from a *different enclave
 *           build* is rejected even with a valid oracle signature.
 *        4. The signed statement covers `block.chainid` and `address(this)` — so a
 *           signature minted for a testnet deployment cannot be replayed against a
 *           mainnet one, or against a second verifier on the same chain.
 *        5. The statement has an expiry — a leaked signature has a bounded lifetime.
 *
 *      Replay of the *same* decision against the same verifier is prevented by
 *      AegisVault, which records every executed decision hash. This contract is
 *      stateless-by-design (`verify` is `view`) so it can also be called
 *      off-chain via `eth_call` for pre-flight checks.
 */
contract AttestationVerifier {
    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner();
    error ZeroAddress();
    error MalformedProof();
    error MalformedSignature();
    error AttestationExpired(uint64 expiry, uint256 nowTs);
    error MeasurementMismatch(bytes32 expected, bytes32 provided);
    error UnauthorizedSigner(address recovered, address expected);
    error HardwareAttestationRequired();

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ExpectedMeasurementUpdated(bytes32 indexed previous, bytes32 indexed current);
    event OwnershipTransferred(address indexed previous, address indexed current);
    event RequireHardwareUpdated(bool previous, bool current);

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Address whose ECDSA signature attests that a TDX quote was verified.
    address public immutable oracleSigner;

    /// @notice Governance address permitted to rotate `expectedMeasurement`.
    address public owner;

    /**
     * @notice Code identity of the enclave build authorised to produce decisions.
     *
     * @dev This is `keccak256(abi.encode(mrtd, rtmr0, rtmr1, rtmr2, composeHash))`
     *      as reported by the dstack guest agent's `info()` endpoint. See
     *      `enclave/attestation.py::compute_measurement` — the two MUST agree
     *      byte-for-byte or every rebalance reverts.
     *
     *      MUTABILITY RATIONALE: this is deliberately *not* immutable. Any
     *      legitimate change to the enclave image (a dependency bump, a model
     *      update) changes the measurement. If this were immutable, every enclave
     *      rebuild would require redeploying both this contract and AegisVault,
     *      whose `attestationVerifier` reference IS immutable — i.e. a full
     *      protocol redeploy. That is not operable.
     *
     *      The cost of mutability is that `owner` can point the protocol at a
     *      different enclave build. Every rotation emits
     *      `ExpectedMeasurementUpdated`, so the change is publicly auditable and a
     *      frontend can surface it. Production deployments should place `owner`
     *      behind a timelock or multisig.
     */
    bytes32 public expectedMeasurement;

    /**
     * @notice When true, only decisions from verified TDX hardware are accepted.
     *
     * @dev The measurement already separates a simulator from real hardware,
     *      because MRTD and RTMR0-2 differ between them and `expectedMeasurement`
     *      is burned in from whichever enclave was running at deploy time. But
     *      that binding is *implicit*: reading this contract told you which build
     *      was authorised, never whether that build ran on real silicon.
     *
     *      `hardwareVerified` is now part of the signed struct, so the oracle
     *      cannot report it one way off-chain and leave the chain to assume
     *      another. This flag turns that signed fact into an enforced condition.
     *
     *      Left false at deploy so a simulator-backed deployment is honest rather
     *      than broken: it records `hardwareVerified=false` against every decision
     *      instead of pretending otherwise. Turn it on once running on real TDX,
     *      and simulator-backed proofs stop verifying.
     */
    bool public requireHardware;

    /**
     * @notice Domain separator constant mixed into the signed digest.
     * @dev Distinguishes an Aegis attestation from any other structure the oracle
     *      key might ever be asked to sign.
     */
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "AegisAttestation(uint256 chainId,address verifier,bytes32 decisionHash,bytes32 measurement,bool hardwareVerified,uint64 expiry)"
    );

    /// @dev secp256k1 group order / 2, used to reject malleable signatures.
    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param _oracleSigner Address of the off-chain DCAP verification oracle.
     * @param _expectedMeasurement Initial enclave code measurement (see above).
     */
    constructor(address _oracleSigner, bytes32 _expectedMeasurement) {
        if (_oracleSigner == address(0)) revert ZeroAddress();
        oracleSigner = _oracleSigner;
        owner = msg.sender;
        expectedMeasurement = _expectedMeasurement;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ExpectedMeasurementUpdated(bytes32(0), _expectedMeasurement);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // -----------------------------------------------------------------------
    // Governance
    // -----------------------------------------------------------------------

    /// @notice Rotate the authorised enclave measurement after a verified rebuild.
    function setExpectedMeasurement(bytes32 _measurement) external onlyOwner {
        bytes32 previous = expectedMeasurement;
        expectedMeasurement = _measurement;
        emit ExpectedMeasurementUpdated(previous, _measurement);
    }

    /**
     * @notice Require verified TDX hardware for every subsequent decision.
     * @dev Not one-way: an operator moving back to a simulator to debug must be
     *      able to say so openly rather than be tempted to forge a quote. Every
     *      change emits `RequireHardwareUpdated`, so it is publicly auditable.
     */
    function setRequireHardware(bool value) external onlyOwner {
        bool previous = requireHardware;
        requireHardware = value;
        emit RequireHardwareUpdated(previous, value);
    }

    /// @notice Hand governance to a timelock/multisig, or to address(0) to freeze.
    function transferOwnership(address newOwner) external onlyOwner {
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // -----------------------------------------------------------------------
    // Verification
    // -----------------------------------------------------------------------

    /**
     * @notice Recompute the digest the oracle is expected to have signed.
     * @dev Exposed publicly so the oracle service and the test suite derive the
     *      digest from the contract itself rather than reimplementing it. Any
     *      drift between the two would otherwise show up only as an opaque
     *      `UnauthorizedSigner` revert.
     */
    function attestationDigest(
        bytes32 decisionHash,
        bytes32 measurement,
        bool hardwareVerified,
        uint64 expiry
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                block.chainid,
                address(this),
                decisionHash,
                measurement,
                hardwareVerified,
                expiry
            )
        );
        // EIP-191 personal_sign envelope — lets the oracle use any standard
        // `eth_sign`-style signer without custom EIP-712 domain plumbing.
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash));
    }

    /**
     * @notice Verify an attestation proof for a rebalance decision.
     * @param decisionHash Hash of the decision, bound into the TDX quote report_data.
     * @param attestationProof `abi.encode(bytes32 measurement, uint64 expiry,
     *        bool hardwareVerified, bytes signature)`.
     * @return hardwareVerified Whether the quote's signature chain was verified
     *         against Intel collateral. Reverts with a specific error on any
     *         failure, so a return value can safely carry information rather
     *         than being a bare success flag.
     */
    function verify(bytes32 decisionHash, bytes calldata attestationProof)
        external
        view
        returns (bool hardwareVerified)
    {
        bytes32 measurement;
        uint64 expiry;
        bytes memory signature;
        (measurement, expiry, hardwareVerified, signature) = _decodeProof(attestationProof);

        if (block.timestamp > expiry) revert AttestationExpired(expiry, block.timestamp);
        if (measurement != expectedMeasurement) revert MeasurementMismatch(expectedMeasurement, measurement);

        // The flag lives inside the signed struct, so a caller cannot flip it to
        // pass this check without invalidating the signature below.
        if (requireHardware && !hardwareVerified) revert HardwareAttestationRequired();

        address recovered =
            _recover(attestationDigest(decisionHash, measurement, hardwareVerified, expiry), signature);
        if (recovered != oracleSigner) revert UnauthorizedSigner(recovered, oracleSigner);

        // Returned rather than discarded so the caller can record *how* the
        // decision was attested. Reverting is the only failure signal; `false`
        // here means "validly attested, but by a simulator".
        return hardwareVerified;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    function _decodeProof(bytes calldata proof)
        private
        pure
        returns (bytes32 measurement, uint64 expiry, bool hardwareVerified, bytes memory signature)
    {
        // Minimum well-formed encoding: four head words (measurement, expiry,
        // hardwareVerified, signature offset) plus the signature's length word.
        // Anything shorter cannot be abi.decoded, and would otherwise surface as
        // an opaque decoder panic instead of a named error.
        if (proof.length < 160) revert MalformedProof();
        (measurement, expiry, hardwareVerified, signature) =
            abi.decode(proof, (bytes32, uint64, bool, bytes));
    }

    /**
     * @dev ECDSA recovery with the two standard hardening checks:
     *      - `s` in the lower half of the curve order (rejects the trivially
     *        malleable sibling of every signature),
     *      - `v` restricted to {27, 28}.
     *      `ecrecover` returns address(0) on failure, which can never equal a
     *      non-zero `oracleSigner` (enforced in the constructor).
     */
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) revert MalformedSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (uint256(s) > _HALF_CURVE_ORDER) revert MalformedSignature();
        if (v != 27 && v != 28) revert MalformedSignature();

        return ecrecover(digest, v, r, s);
    }
}
