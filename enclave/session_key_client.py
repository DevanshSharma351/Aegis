"""
Aegis Enclave — Session Key Client Stub

This module provides the interface for the enclave to submit userOps
through the identity/ workstream (Workstream B). It calls into the
identity service to submit signed UserOperations via the session key.

NOTE: This is a stub — the actual session key infrastructure is built
in Workstream B (identity/). This module will be wired up once
identity/src/submitUserOp.ts is available and the session key is live.
"""

import json
import os
import subprocess
from typing import Any


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Path to the identity service's submitUserOp script.
# In Docker, this resolves via the shared filesystem or an HTTP call.
_IDENTITY_DIR = os.environ.get(
    "IDENTITY_SERVICE_DIR",
    str(((__import__("pathlib").Path(__file__).resolve().parent / ".." / "identity").resolve())),
)


def submit_rebalance_userop(
    vault_address: str,
    decision_hash: bytes,
    attestation_proof: bytes,
) -> dict[str, Any]:
    """
    Submit a rebalance UserOperation through the session key.

    This calls identity/src/submitUserOp.ts to build and submit a
    UserOperation that calls AegisVault.rebalance(decisionHash, attestationProof).

    Args:
        vault_address: The deployed AegisVault contract address.
        decision_hash: 32-byte decision hash (bytes32).
        attestation_proof: Encoded attestation proof bytes.

    Returns:
        Dict with: { txHash, success, error? }

    TODO: In the Docker compose setup, this will be an HTTP call to the
    identity init container rather than a subprocess call. Update this
    once the integration layer (Prompt 5) is built.
    """
    # For now, this is a placeholder that documents the interface contract.
    # The actual implementation depends on Workstream B being live.
    print(
        f"[session_key_client] STUB: would submit rebalance userOp to {vault_address} "
        f"with decision_hash={decision_hash.hex()[:16]}..."
    )
    return {
        "txHash": None,
        "success": False,
        "error": "session_key_client is a stub — wire up identity/ service (Workstream B)",
    }
