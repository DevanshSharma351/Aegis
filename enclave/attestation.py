"""
Aegis Enclave — dstack TEE Attestation Wrapper

Wraps dstack_sdk.DstackClient().get_quote() to produce hardware-backed
attestation quotes for rebalance decisions.

The attestation binds the decision hash to the enclave's code measurement,
providing cryptographic proof that the decision was computed inside a
genuine TEE with known, unmodified code.
"""

import hashlib
import json
import os
from typing import Any

from dstack_sdk import TappdClient


# ---------------------------------------------------------------------------
# Attestation
# ---------------------------------------------------------------------------

def compute_decision_hash(decision: dict[str, Any]) -> bytes:
    """
    Compute a deterministic SHA-256 hash of a rebalance decision.

    The hash covers the full allocation + rationale + confidence, serialized
    as sorted-key JSON. This is the value bound into the TEE attestation
    quote's report_data field.

    Returns:
        32-byte SHA-256 digest.
    """
    # Canonical serialization: sorted keys, no whitespace, no trailing newline.
    canonical = json.dumps(decision, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).digest()


def attest_decision(decision: dict[str, Any]) -> dict[str, Any]:
    """
    Generate a TEE attestation quote for a rebalance decision.

    1. Computes a deterministic hash of the decision.
    2. Passes the hash as report_data to the dstack TEE quote API.
    3. Returns the quote bytes + metadata for on-chain verification.

    The `quote` field is ABI-encoded as (bytes32 decisionHash, bytes32 measurementHash)
    so the on-chain AttestationVerifier.verify() can abi.decode it directly.

    The mock measurement hash matches the value set in Deploy.s.sol:
        keccak256("MOCK_ENCLAVE_MEASUREMENT")

    In production this would be replaced with the real MRTD/RTMR from the
    TDX quote, verified on-chain via a full DCAP verifier library.

    Args:
        decision: The allocation dict from the SLM (allocations, rationale, confidence).

    Returns:
        Dict with keys:
        - quote: hex-encoded ABI-encoded proof bytes (bytes32 ++ bytes32)
        - report_data_hash: hex-encoded SHA-256 of the decision
        - event_log: summary string for the on-chain event
        - raw_tdx_quote: hex-encoded raw TDX quote (for off-chain audit)
    """
    decision_hash = compute_decision_hash(decision)

    # dstack_sdk.DstackClient auto-detects the endpoint:
    # - If DSTACK_SIMULATOR_ENDPOINT is set, connects to the simulator.
    # - Otherwise, connects to /var/run/tappd.sock (real TDX hardware).
    client = TappdClient()

    # tdx_quote expects report_data as bytes or str, max 64 bytes for raw or hashes.
    # SHA-256 produces exactly 32 bytes — well within the limit.
    quote_response = client.tdx_quote(decision_hash)

    # The quote_response contains the raw TDX quote bytes (for audit/off-chain use).
    raw_quote_bytes = quote_response.quote

    # ---------------------------------------------------------------------------
    # Build ABI-encoded proof for the on-chain AttestationVerifier.
    #
    # The verifier does:
    #   (bytes32 reportDataHash, bytes32 measurementHash) = abi.decode(proof, (bytes32, bytes32))
    #
    # ABI encoding of two static bytes32 values is simply their concatenation.
    # Mock measurement = keccak256("MOCK_ENCLAVE_MEASUREMENT") from Deploy.s.sol
    # ---------------------------------------------------------------------------
    MOCK_MEASUREMENT_HEX = "a1bb2773ecc99e5ac83b377edfb45efc514c4ceac893c8db62ed88cec4f4f7c3"
    mock_measurement_bytes = bytes.fromhex(MOCK_MEASUREMENT_HEX)

    # ABI encode: both are already 32 bytes, concatenate directly
    report_data_hash_b32 = decision_hash[:32].ljust(32, b'\x00')  # sha256 is already 32 bytes
    measurement_hash_b32 = mock_measurement_bytes[:32].ljust(32, b'\x00')

    abi_encoded_proof = report_data_hash_b32 + measurement_hash_b32

    return {
        "quote": abi_encoded_proof.hex(),
        "report_data_hash": decision_hash.hex(),
        "event_log": f"attested decision {decision_hash.hex()[:16]}... at TEE",
        "raw_tdx_quote": raw_quote_bytes.hex() if isinstance(raw_quote_bytes, bytes) else str(raw_quote_bytes),
    }
