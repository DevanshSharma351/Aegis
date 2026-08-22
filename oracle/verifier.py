"""
Aegis attestation oracle — verification logic.

This module decides whether a TDX quote justifies signing an on-chain
attestation. It is the component that carries the trust the on-chain verifier
cannot: AttestationVerifier.sol checks one ECDSA signature, and everything that
signature is worth depends on the checks performed here.

WHAT IS CHECKED (all of it, in order — any failure aborts, none are advisory):

  1. The blob parses as a TDX v4 quote for TEE type TDX.
  2. The quote's report_data carries exactly the decision hash being attested.
     Without this, a valid quote could be paired with an arbitrary decision.
  3. The supplied event log replays to the quote's RTMR0..RTMR3. This makes the
     log authentic — a single altered entry changes the final register.
  4. The compose hash is read out of that authenticated log, not from the
     request body. It is the field that pins the container images, so taking the
     caller's word for it would make steps 1-3 pointless.
  5. The derived measurement appears in the configured allowlist, if one is set.
  6. In hardware mode, the quote's signature chain is verified through the
     dstack verifier service against Intel PCS collateral.

WHAT IS NOT CHECKED, AND WHY IT MATTERS:

  In simulator mode there is no Intel signature to verify — the quote is a
  canned blob with report_data patched in. Steps 1-5 still run and still catch a
  mismatched decision, a forged event log, or an unexpected measurement. What
  they cannot establish is that any of it came from real hardware. That is why
  `source` is carried through every response and into deployed.json, and why
  AEGIS_REQUIRE_HARDWARE exists: set it, and the oracle refuses to sign anything
  a simulator produced.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

import requests

from aegis_tdx import (
    EventLogError,
    QuoteParseError,
    TdxQuote,
    collect_boot_events,
    compose_hash_from_event_log,
    measurement_from_quote,
    parse_quote,
    verify_event_log,
)

SOURCE_SIMULATOR = "simulator"
SOURCE_HARDWARE = "hardware-tdx"


class AttestationRejected(Exception):
    """Raised when a quote does not justify an on-chain attestation."""

    def __init__(self, reason: str, stage: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.stage = stage


@dataclass(frozen=True)
class VerificationResult:
    """Everything the signer needs, plus an audit trail of what was checked."""

    decision_hash: bytes
    measurement: bytes
    compose_hash: str
    source: str
    quote: TdxQuote
    boot_events: dict[str, str] = field(default_factory=dict)
    checks: list[str] = field(default_factory=list)
    hardware_verified: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "decisionHash": "0x" + self.decision_hash.hex(),
            "measurement": "0x" + self.measurement.hex(),
            "composeHash": self.compose_hash,
            "source": self.source,
            "hardwareVerified": self.hardware_verified,
            "mrtd": self.quote.mrtd.hex(),
            "rtmr0": self.quote.rtmr0.hex(),
            "rtmr1": self.quote.rtmr1.hex(),
            "rtmr2": self.quote.rtmr2.hex(),
            "rtmr3": self.quote.rtmr3.hex(),
            "bootEvents": self.boot_events,
            "checksPerformed": self.checks,
        }


def _hex_to_bytes(name: str, value: str, length: Optional[int] = None) -> bytes:
    stripped = value[2:] if value.startswith("0x") else value
    try:
        raw = bytes.fromhex(stripped)
    except ValueError as exc:
        raise AttestationRejected(f"{name} is not valid hex: {value!r}", stage="input") from exc
    if length is not None and len(raw) != length:
        raise AttestationRejected(
            f"{name} must be {length} bytes, got {len(raw)}", stage="input"
        )
    return raw


def measurement_allowlist() -> set[str]:
    """
    Measurements this oracle is willing to attest, as lowercase 0x-prefixed hex.

    Configured via AEGIS_MEASUREMENT_ALLOWLIST (comma-separated). Empty means no
    allowlist, which is the correct default during bootstrap: the very first
    deploy needs the oracle to sign for a measurement that has not been recorded
    anywhere yet. Once deployed, set it — it is what stops a compromised enclave
    from getting a rebuilt image attested.
    """
    raw = os.environ.get("AEGIS_MEASUREMENT_ALLOWLIST", "")
    return {entry.strip().lower() for entry in raw.split(",") if entry.strip()}


def require_hardware() -> bool:
    """Whether simulator-sourced quotes must be rejected outright."""
    return os.environ.get("AEGIS_REQUIRE_HARDWARE", "").strip().lower() in {"1", "true", "yes"}


def _verify_hardware_quote(quote_hex: str) -> None:
    """
    Verify the quote's signature chain via the dstack verifier service.

    The verifier checks the QE report signature and the PCK certificate chain
    against Intel's collateral — the part this process cannot do itself without
    embedding a full DCAP stack.

    Configured by AEGIS_DSTACK_VERIFIER_URL. In hardware mode the URL is
    mandatory: silently skipping signature verification because a URL was
    forgotten would turn the strongest check in the pipeline into a no-op.
    """
    verifier_url = os.environ.get("AEGIS_DSTACK_VERIFIER_URL", "").strip()
    if not verifier_url:
        raise AttestationRejected(
            "AEGIS_REQUIRE_HARDWARE is set but AEGIS_DSTACK_VERIFIER_URL is not. "
            "Refusing to treat an unverified quote as hardware-attested.",
            stage="hardware-verification",
        )

    try:
        response = requests.post(
            verifier_url.rstrip("/") + "/verify",
            json={"quote": quote_hex},
            timeout=float(os.environ.get("AEGIS_VERIFIER_TIMEOUT_S", "30")),
        )
    except requests.RequestException as exc:
        raise AttestationRejected(
            f"dstack verifier at {verifier_url} unreachable: {exc}",
            stage="hardware-verification",
        ) from exc

    if response.status_code != 200:
        raise AttestationRejected(
            f"dstack verifier returned HTTP {response.status_code}: {response.text[:300]}",
            stage="hardware-verification",
        )

    body = response.json()
    if not body.get("verified", body.get("valid", False)):
        raise AttestationRejected(
            f"dstack verifier rejected the quote: {body}",
            stage="hardware-verification",
        )


def verify_attestation(
    quote_hex: str,
    decision_hash_hex: str,
    event_log: str,
    source: str = SOURCE_SIMULATOR,
) -> VerificationResult:
    """
    Run the full verification chain. Raises AttestationRejected on any failure.

    Args:
        quote_hex: TDX quote, hex encoded.
        decision_hash_hex: The 32-byte decision hash this quote should be bound to.
        event_log: The guest agent's event log JSON, as a string.
        source: 'simulator' or 'hardware-tdx', as reported by the enclave.
    """
    checks: list[str] = []

    decision_hash = _hex_to_bytes("decisionHash", decision_hash_hex, length=32)

    # --- 1. Structural parse ------------------------------------------------
    try:
        quote = parse_quote(quote_hex)
    except QuoteParseError as exc:
        raise AttestationRejected(str(exc), stage="quote-parse") from exc
    checks.append(f"quote parsed as TDX v{quote.version}")

    # --- 2. Decision binding ------------------------------------------------
    if quote.report_data_32 != decision_hash:
        raise AttestationRejected(
            "quote report_data does not carry the decision hash: quote has "
            f"{quote.report_data_32.hex()}, request claims {decision_hash.hex()}",
            stage="decision-binding",
        )
    checks.append("report_data matches decision hash")

    # --- 3. Event log authenticity -----------------------------------------
    try:
        verify_event_log(quote, event_log)
    except EventLogError as exc:
        raise AttestationRejected(str(exc), stage="event-log-replay") from exc
    checks.append("event log replays to attested RTMR0-3")

    # --- 4. Compose hash, from the now-authenticated log --------------------
    try:
        compose_hash = compose_hash_from_event_log(event_log)
    except EventLogError as exc:
        raise AttestationRejected(str(exc), stage="compose-hash") from exc
    checks.append("compose hash recovered from attested event log")

    boot_events = collect_boot_events(event_log)

    # --- 5. Measurement derivation and allowlist ----------------------------
    measurement = measurement_from_quote(quote, compose_hash)
    measurement_hex = "0x" + measurement.hex()
    checks.append("measurement derived from quote registers")

    allowlist = measurement_allowlist()
    if allowlist and measurement_hex.lower() not in allowlist:
        raise AttestationRejected(
            f"measurement {measurement_hex} is not in the configured allowlist. "
            "This enclave build is not authorised to produce decisions.",
            stage="measurement-allowlist",
        )
    if allowlist:
        checks.append("measurement is allowlisted")

    # --- 6. Hardware signature chain ---------------------------------------
    hardware_verified = False
    if require_hardware():
        if source != SOURCE_HARDWARE:
            raise AttestationRejected(
                f"AEGIS_REQUIRE_HARDWARE is set but the enclave reported source "
                f"{source!r}. Refusing to sign a simulator attestation.",
                stage="hardware-required",
            )
        _verify_hardware_quote(quote_hex)
        hardware_verified = True
        checks.append("quote signature chain verified against Intel collateral")
    else:
        checks.append(
            "hardware signature chain NOT verified (AEGIS_REQUIRE_HARDWARE unset)"
        )

    return VerificationResult(
        decision_hash=decision_hash,
        measurement=measurement,
        compose_hash=compose_hash,
        source=source,
        quote=quote,
        boot_events=boot_events,
        checks=checks,
        hardware_verified=hardware_verified,
    )
