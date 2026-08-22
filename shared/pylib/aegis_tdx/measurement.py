"""
Canonical derivation of the two 32-byte values Aegis binds on-chain.

  decision hash -- keccak256 over the canonical JSON of a rebalance decision.
                   Goes into the TDX quote report_data field, and is what
                   AegisVault records in its event log.

  measurement   -- keccak256 over the enclave TDX measurement registers.
                   This is what AttestationVerifier.expectedMeasurement holds.

Both definitions are load-bearing across four places (the Python enclave, the
Python oracle, the Solidity verifier, and the TypeScript pipeline checks), so
they are specified here byte-for-byte and nowhere else.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Union

from .keccak import keccak256
from .quote import TdxQuote, parse_quote

# Domain separators. Prefixing each preimage means a measurement digest can
# never collide with a decision digest, a compose hash, or any other 32-byte
# value in the system, even if an attacker controls the trailing content.
AEGIS_MEASUREMENT_DOMAIN = b"AegisEnclaveMeasurement:v1"
AEGIS_DECISION_DOMAIN = b"AegisDecision:v1"

_REGISTER_LENGTH = 48
_COMPOSE_HASH_LENGTH = 32


def compute_decision_hash(decision: Mapping[str, Any]) -> bytes:
    """
    Hash a rebalance decision deterministically.

    The preimage is `AegisDecision:v1` followed by the decision serialised as
    JSON with sorted keys and no insignificant whitespace. Sorting makes the
    hash independent of dict insertion order, so an enclave restart or a Python
    version change cannot alter it for the same logical decision.

    Returns:
        32-byte digest, valid as both a TDX report_data payload and a Solidity
        bytes32.
    """
    canonical = json.dumps(decision, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return keccak256(AEGIS_DECISION_DOMAIN + canonical)


def _require(name: str, value: bytes, length: int) -> bytes:
    if len(value) != length:
        raise ValueError(f"{name} must be {length} bytes, got {len(value)}")
    return value


def _to_bytes(name: str, value: Union[str, bytes], length: int) -> bytes:
    if isinstance(value, str):
        stripped = value[2:] if value.startswith("0x") else value
        try:
            value = bytes.fromhex(stripped)
        except ValueError as exc:
            raise ValueError(f"{name} is not valid hex: {value!r}") from exc
    return _require(name, bytes(value), length)


def compute_measurement(
    mrtd: Union[str, bytes],
    rtmr0: Union[str, bytes],
    rtmr1: Union[str, bytes],
    rtmr2: Union[str, bytes],
    compose_hash: Union[str, bytes],
) -> bytes:
    """
    Derive the Aegis enclave measurement.

        keccak256(
            "AegisEnclaveMeasurement:v1"
            || mrtd          (48 bytes)
            || rtmr0         (48 bytes)
            || rtmr1         (48 bytes)
            || rtmr2         (48 bytes)
            || compose_hash  (32 bytes)
        )

    WHY THESE FIVE, AND WHY NOT RTMR3:

      mrtd          measures initial TD memory: the guest firmware and kernel
                    image the enclave booted from.
      rtmr0/1/2     measure virtual firmware config, the kernel/initrd/cmdline,
                    and the application boot chain. Together with mrtd they pin
                    the entire software stack below the workload.
      compose_hash  pins the app-compose document, which names the container
                    images by digest. This is the field that actually changes
                    when the Aegis enclave image is rebuilt, and it is why a
                    rebuilt image cannot pass a stale measurement.

      rtmr3         is deliberately EXCLUDED. dstack extends RTMR3 at runtime
                    with per-instance events (instance id, key provider, app
                    id), so it differs between two instances of the same image.
                    Including it would make the measurement per-instance rather
                    than per-build, and every enclave restart would then require
                    an on-chain measurement rotation.

    Returns:
        32-byte digest matching AttestationVerifier.expectedMeasurement.
    """
    preimage = (
        AEGIS_MEASUREMENT_DOMAIN
        + _to_bytes("mrtd", mrtd, _REGISTER_LENGTH)
        + _to_bytes("rtmr0", rtmr0, _REGISTER_LENGTH)
        + _to_bytes("rtmr1", rtmr1, _REGISTER_LENGTH)
        + _to_bytes("rtmr2", rtmr2, _REGISTER_LENGTH)
        + _to_bytes("compose_hash", compose_hash, _COMPOSE_HASH_LENGTH)
    )
    return keccak256(preimage)


def measurement_from_tcb_info(
    tcb_info: Mapping[str, Any],
    compose_hash: Union[str, bytes],
) -> bytes:
    """Derive the measurement from a dstack Info response tcb_info block."""
    return compute_measurement(
        tcb_info["mrtd"],
        tcb_info["rtmr0"],
        tcb_info["rtmr1"],
        tcb_info["rtmr2"],
        compose_hash,
    )


def measurement_from_quote(
    quote: Union[str, bytes, TdxQuote],
    compose_hash: Union[str, bytes],
) -> bytes:
    """
    Derive the measurement from the quote bytes themselves.

    This is the path the oracle uses. Every register comes out of the attested
    TD report body, so an enclave cannot misreport its own registers by
    decorating the response with different JSON.

    `compose_hash` is not carried in the TD report body, so the oracle must
    cross-check it independently -- see oracle/verifier.py, which recomputes it
    from the app-compose document and refuses to sign on mismatch.
    """
    parsed = quote if isinstance(quote, TdxQuote) else parse_quote(quote)
    return compute_measurement(
        parsed.mrtd,
        parsed.rtmr0,
        parsed.rtmr1,
        parsed.rtmr2,
        compose_hash,
    )
