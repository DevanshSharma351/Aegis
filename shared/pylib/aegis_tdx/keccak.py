"""
keccak256 with an explicitly resolved backend.

The enclave and the oracle must produce byte-identical measurements, and the
on-chain verifier compares against a constant derived from them. Silently
falling back to NIST SHA3-256 -- which hashlib exposes as `sha3_256`, and which
is NOT keccak256 -- would produce a value that never matches, with no symptom
beyond an opaque revert. So this module resolves a real keccak backend at
import time and raises immediately if none is present, rather than degrading.
"""

from __future__ import annotations

from typing import Callable

_keccak256: Callable[[bytes], bytes]
BACKEND: str

try:  # Preferred: the same implementation the Ethereum tooling uses.
    from eth_hash.auto import keccak as _eth_keccak

    def _keccak256(data: bytes) -> bytes:  # type: ignore[no-redef]
        return bytes(_eth_keccak(data))

    BACKEND = "eth-hash"
except ImportError:  # pragma: no cover - only when eth-hash is absent
    try:
        from Crypto.Hash import keccak as _pycryptodome_keccak

        def _keccak256(data: bytes) -> bytes:  # type: ignore[no-redef]
            return _pycryptodome_keccak.new(digest_bits=256, data=data).digest()

        BACKEND = "pycryptodome"
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "No keccak256 backend available. Install eth-hash[pycryptodome] or "
            "pycryptodome. hashlib.sha3_256 is NIST SHA3 and is NOT a "
            "substitute: using it would silently produce measurements that can "
            "never match the on-chain constant."
        ) from exc


def keccak256(data: bytes) -> bytes:
    """Return the 32-byte keccak256 digest of `data`."""
    return _keccak256(data)
