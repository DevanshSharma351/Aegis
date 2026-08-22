"""
Minimal Intel TDX quote (v4) parser.

Scope: extract the TD report body's measurement registers and report_data.
This is NOT a DCAP verifier — it does not check the PCK certificate chain, the
QE report signature, or Intel's TCB collateral. Those checks are what a real
DCAP verifier performs, and their absence is the documented gap between this
deployment and a production one (see AttestationVerifier.sol's header).

What this parser IS for: letting the oracle derive the enclave measurement and
the bound report_data from the quote bytes themselves, rather than trusting a
JSON field the enclave supplied alongside them. That distinction matters — an
enclave that lied about its own measurement in a sidecar field would be caught
here, because the value that gets signed comes out of the attested structure.

Layout reference: Intel TDX DCAP Quoting Library API, "TD Quote Body"
(TDReport10, 584 bytes), which begins at byte 48 of a v4 quote — immediately
after the 48-byte quote header.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Union

# Quote header
_HEADER_SIZE = 48
_HEADER_VERSION_OFFSET = 0
_HEADER_ATTESTATION_KEY_TYPE_OFFSET = 2
_HEADER_TEE_TYPE_OFFSET = 4

_TEE_TYPE_TDX = 0x00000081
_SUPPORTED_VERSIONS = (4, 5)

# TD report body (TDReport10), relative to the start of the body.
_BODY_SIZE = 584
TD_REPORT_OFFSETS = {
    "tee_tcb_svn": (0, 16),
    "mr_seam": (16, 48),
    "mr_signer_seam": (64, 48),
    "seam_attributes": (112, 8),
    "td_attributes": (120, 8),
    "xfam": (128, 8),
    "mrtd": (136, 48),
    "mr_config_id": (184, 48),
    "mr_owner": (232, 48),
    "mr_owner_config": (280, 48),
    "rtmr0": (328, 48),
    "rtmr1": (376, 48),
    "rtmr2": (424, 48),
    "rtmr3": (472, 48),
    "report_data": (520, 64),
}


class QuoteParseError(ValueError):
    """Raised when a blob is not a parseable TDX v4/v5 quote."""


@dataclass(frozen=True)
class TdxQuote:
    """Measurement registers and bound data extracted from a TDX quote."""

    version: int
    tee_type: int
    mrtd: bytes
    rtmr0: bytes
    rtmr1: bytes
    rtmr2: bytes
    rtmr3: bytes
    report_data: bytes
    raw: bytes

    @property
    def report_data_32(self) -> bytes:
        """
        The first 32 bytes of report_data.

        Aegis binds a 32-byte decision hash into a 64-byte field, so the
        remaining 32 bytes are zero padding. Callers comparing against a
        decision hash want this, not the padded field.
        """
        return self.report_data[:32]

    def as_dict(self) -> dict[str, str]:
        return {
            "version": str(self.version),
            "mrtd": self.mrtd.hex(),
            "rtmr0": self.rtmr0.hex(),
            "rtmr1": self.rtmr1.hex(),
            "rtmr2": self.rtmr2.hex(),
            "rtmr3": self.rtmr3.hex(),
            "report_data": self.report_data.hex(),
        }


def _coerce(blob: Union[bytes, bytearray, str]) -> bytes:
    if isinstance(blob, str):
        stripped = blob[2:] if blob.startswith("0x") else blob
        try:
            return bytes.fromhex(stripped)
        except ValueError as exc:
            raise QuoteParseError(f"quote is not valid hex: {exc}") from exc
    return bytes(blob)


def _field(body: bytes, name: str) -> bytes:
    offset, length = TD_REPORT_OFFSETS[name]
    return body[offset : offset + length]


def parse_quote(blob: Union[bytes, bytearray, str]) -> TdxQuote:
    """
    Parse a TDX quote and return its measurement registers.

    Args:
        blob: Raw quote bytes, or a hex string (with or without a 0x prefix).

    Raises:
        QuoteParseError: on a truncated blob, an unsupported quote version, or a
            TEE type that is not TDX. Each is a distinct, actionable failure —
            an SGX quote reaching this code path is a configuration error, not a
            malformed input.
    """
    raw = _coerce(blob)

    if len(raw) < _HEADER_SIZE + _BODY_SIZE:
        raise QuoteParseError(
            f"quote too short: {len(raw)} bytes, need at least "
            f"{_HEADER_SIZE + _BODY_SIZE} for header + TD report body"
        )

    version = int.from_bytes(raw[_HEADER_VERSION_OFFSET : _HEADER_VERSION_OFFSET + 2], "little")
    if version not in _SUPPORTED_VERSIONS:
        raise QuoteParseError(
            f"unsupported quote version {version}; expected one of {_SUPPORTED_VERSIONS}"
        )

    tee_type = int.from_bytes(raw[_HEADER_TEE_TYPE_OFFSET : _HEADER_TEE_TYPE_OFFSET + 4], "little")
    if tee_type != _TEE_TYPE_TDX:
        raise QuoteParseError(
            f"quote tee_type is 0x{tee_type:08x}, not TDX (0x{_TEE_TYPE_TDX:08x}). "
            "An SGX quote cannot attest a TDX guest."
        )

    body = raw[_HEADER_SIZE : _HEADER_SIZE + _BODY_SIZE]

    return TdxQuote(
        version=version,
        tee_type=tee_type,
        mrtd=_field(body, "mrtd"),
        rtmr0=_field(body, "rtmr0"),
        rtmr1=_field(body, "rtmr1"),
        rtmr2=_field(body, "rtmr2"),
        rtmr3=_field(body, "rtmr3"),
        report_data=_field(body, "report_data"),
        raw=raw,
    )
