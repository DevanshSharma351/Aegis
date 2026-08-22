"""
aegis_tdx — shared TDX quote parsing and measurement derivation.

This package is deliberately small, dependency-light, and shared verbatim by
the enclave and the attestation oracle. Both sides MUST derive the enclave
measurement through exactly the same code, because the on-chain
AttestationVerifier compares the oracle's value against a constant that was
itself produced by the enclave. Two independent implementations would drift,
and the drift would surface only as an opaque revert at execution time.
"""

from .eventlog import (
    EventLogError,
    collect_boot_events,
    compose_hash_from_event_log,
    find_event_payload,
    parse_event_log,
    replay_rtmrs,
    verify_event_log,
)
from .measurement import (
    AEGIS_MEASUREMENT_DOMAIN,
    compute_decision_hash,
    compute_measurement,
    measurement_from_quote,
    measurement_from_tcb_info,
)
from .quote import (
    TD_REPORT_OFFSETS,
    TdxQuote,
    QuoteParseError,
    parse_quote,
)

__all__ = [
    "AEGIS_MEASUREMENT_DOMAIN",
    "EventLogError",
    "collect_boot_events",
    "compose_hash_from_event_log",
    "find_event_payload",
    "parse_event_log",
    "replay_rtmrs",
    "verify_event_log",
    "TD_REPORT_OFFSETS",
    "TdxQuote",
    "QuoteParseError",
    "compute_decision_hash",
    "compute_measurement",
    "measurement_from_quote",
    "measurement_from_tcb_info",
    "parse_quote",
]
