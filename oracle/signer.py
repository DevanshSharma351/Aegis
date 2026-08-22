"""
Aegis attestation oracle — signing.

Produces the `attestationProof` blob that AegisVault.rebalance forwards to
AttestationVerifier.verify. The digest computed here must match
AttestationVerifier.attestationDigest byte-for-byte; a mismatch surfaces only as
an `UnauthorizedSigner` revert with a plausible-looking recovered address, which
is a miserable thing to debug. So the layout is spelled out here beside the
Solidity it mirrors, and oracle/test_signer.py cross-checks the two by calling
the deployed contract.

Solidity side (AttestationVerifier.sol):

    structHash = keccak256(abi.encode(
        ATTESTATION_TYPEHASH,   // bytes32
        block.chainid,          // uint256
        address(this),          // address
        decisionHash,           // bytes32
        measurement,            // bytes32
        expiry                  // uint64
    ))
    digest = keccak256("\\x19Ethereum Signed Message:\\n32" || structHash)

`abi.encode` pads every value to 32 bytes, including the address (left-padded)
and the uint64 (left-padded). That padding is why this cannot be built with
`abi.encodePacked`-style concatenation.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak, to_checksum_address

# keccak256("AegisAttestation(uint256 chainId,address verifier,bytes32 decisionHash,bytes32 measurement,uint64 expiry)")
ATTESTATION_TYPEHASH = keccak(
    b"AegisAttestation(uint256 chainId,address verifier,bytes32 decisionHash,"
    b"bytes32 measurement,uint64 expiry)"
)

# How long a signed attestation stays valid. Short enough that a leaked
# signature is not indefinitely useful, long enough to absorb bundler latency
# and a slow Sepolia block.
DEFAULT_VALIDITY_SECONDS = int(os.environ.get("AEGIS_ATTESTATION_TTL_S", "900"))


class SignerError(RuntimeError):
    """Raised when the oracle cannot sign."""


@dataclass(frozen=True)
class SignedAttestation:
    decision_hash: bytes
    measurement: bytes
    expiry: int
    signature: bytes
    signer: str
    verifier: str
    chain_id: int

    @property
    def proof(self) -> bytes:
        """
        `abi.encode(bytes32 measurement, uint64 expiry, bytes signature)` —
        the exact calldata AttestationVerifier._decodeProof expects.
        """
        return _abi_encode_proof(self.measurement, self.expiry, self.signature)

    def as_dict(self) -> dict[str, object]:
        return {
            "decisionHash": "0x" + self.decision_hash.hex(),
            "measurement": "0x" + self.measurement.hex(),
            "expiry": self.expiry,
            "signature": "0x" + self.signature.hex(),
            "proof": "0x" + self.proof.hex(),
            "oracleSigner": self.signer,
            "verifier": self.verifier,
            "chainId": self.chain_id,
        }


def _word(value: bytes) -> bytes:
    """Left-pad to a 32-byte ABI word."""
    if len(value) > 32:
        raise SignerError(f"value of {len(value)} bytes does not fit an ABI word")
    return value.rjust(32, b"\x00")


def attestation_digest(
    chain_id: int,
    verifier: str,
    decision_hash: bytes,
    measurement: bytes,
    expiry: int,
) -> bytes:
    """Recompute AttestationVerifier.attestationDigest off-chain."""
    verifier_bytes = bytes.fromhex(to_checksum_address(verifier)[2:])

    struct_hash = keccak(
        ATTESTATION_TYPEHASH
        + _word(chain_id.to_bytes(32, "big"))
        + _word(verifier_bytes)
        + _word(decision_hash)
        + _word(measurement)
        + _word(expiry.to_bytes(8, "big"))
    )

    # EIP-191 personal_sign envelope, matching the Solidity abi.encodePacked.
    return keccak(b"\x19Ethereum Signed Message:\n32" + struct_hash)


def _abi_encode_proof(measurement: bytes, expiry: int, signature: bytes) -> bytes:
    """
    Hand-roll `abi.encode(bytes32, uint64, bytes)`.

    Head:  measurement word, expiry word, offset-to-bytes word (0x60 = 96).
    Tail:  signature length word, then the signature right-padded to a
           multiple of 32.
    """
    head = _word(measurement) + _word(expiry.to_bytes(8, "big")) + _word((96).to_bytes(32, "big"))

    padding = (-len(signature)) % 32
    tail = _word(len(signature).to_bytes(32, "big")) + signature + b"\x00" * padding

    return head + tail


def load_oracle_account() -> Account:
    """
    Load the oracle signing key.

    Kept separate from the deployer and owner keys in any real deployment: this
    key alone decides which enclave measurements the protocol will accept, so
    reusing it as a general-purpose EOA widens the blast radius of a leak from
    "the oracle" to "everything".
    """
    key = os.environ.get("AEGIS_ORACLE_PRIVATE_KEY", "").strip()
    if not key:
        raise SignerError(
            "AEGIS_ORACLE_PRIVATE_KEY is not set. The oracle cannot sign "
            "attestations without its signing key."
        )
    if not key.startswith("0x"):
        key = "0x" + key
    try:
        return Account.from_key(key)
    except Exception as exc:
        raise SignerError(f"AEGIS_ORACLE_PRIVATE_KEY is not a valid private key: {exc}") from exc


def sign_attestation(
    decision_hash: bytes,
    measurement: bytes,
    chain_id: int,
    verifier: str,
    validity_seconds: int = DEFAULT_VALIDITY_SECONDS,
) -> SignedAttestation:
    """Sign a verified attestation for on-chain submission."""
    if len(decision_hash) != 32:
        raise SignerError(f"decision hash must be 32 bytes, got {len(decision_hash)}")
    if len(measurement) != 32:
        raise SignerError(f"measurement must be 32 bytes, got {len(measurement)}")

    account = load_oracle_account()
    expiry = int(time.time()) + validity_seconds

    digest = attestation_digest(chain_id, verifier, decision_hash, measurement, expiry)

    # The digest already carries the EIP-191 envelope, so sign it as raw 32
    # bytes. Passing it through encode_defunct again would wrap it twice and
    # recover to a different address on-chain.
    signed = account.unsafe_sign_hash(digest)
    signature = signed.signature

    # Guard against a malleable `s`. The verifier rejects the upper half of the
    # curve order outright, and eth-account can emit either form depending on
    # version, so normalise here rather than discovering it as a revert.
    r, s, v = signed.r, signed.s, signed.v
    secp256k1_n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    if s > secp256k1_n // 2:
        s = secp256k1_n - s
        v = 27 if v == 28 else 28
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big") + bytes([v])

    return SignedAttestation(
        decision_hash=decision_hash,
        measurement=measurement,
        expiry=expiry,
        signature=bytes(signature),
        signer=account.address,
        verifier=to_checksum_address(verifier),
        chain_id=chain_id,
    )


# Kept for callers that only need to reproduce the personal_sign envelope.
__all__ = [
    "ATTESTATION_TYPEHASH",
    "DEFAULT_VALIDITY_SECONDS",
    "SignedAttestation",
    "SignerError",
    "attestation_digest",
    "encode_defunct",
    "load_oracle_account",
    "sign_attestation",
]
