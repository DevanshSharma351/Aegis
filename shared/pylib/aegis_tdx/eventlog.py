"""
TDX event log replay.

The measurement registers in a quote are opaque 48-byte digests. The event log
is the human-readable derivation of how they got that way — but a log supplied
alongside a quote proves nothing on its own, because whoever sent the quote also
sent the log.

Replaying the log closes that gap. Each RTMR starts at zero and is extended as

    RTMR := SHA384(RTMR || event_digest)

for every event recorded against it, in order. If a replay reproduces the value
the quote attests to, the log is authentic: it is not possible to add, remove,
or alter an entry without changing the final register.

Why Aegis needs this: `compose_hash` is what actually pins the enclave's
container images, and it is NOT carried in the TD report body — only in an
event-log entry. Without replay, the oracle would be taking the caller's word
for the single field that identifies the workload. With replay, the compose
hash is recovered from a log that the hardware-attested RTMR3 vouches for.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, Mapping, Sequence, Union

from .quote import TdxQuote, parse_quote

_RTMR_COUNT = 4
_DIGEST_SIZE = 48

# dstack records these as event-log entries against RTMR3 during boot.
EVENT_COMPOSE_HASH = "compose-hash"
EVENT_APP_ID = "app-id"
EVENT_INSTANCE_ID = "instance-id"
EVENT_OS_IMAGE_HASH = "os-image-hash"


class EventLogError(ValueError):
    """Raised when an event log is malformed or does not match its quote."""


def parse_event_log(event_log: Union[str, Sequence[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """Accept either the raw JSON string from the guest agent or a decoded list."""
    if isinstance(event_log, str):
        if not event_log.strip():
            raise EventLogError("event log is empty")
        try:
            decoded = json.loads(event_log)
        except json.JSONDecodeError as exc:
            raise EventLogError(f"event log is not valid JSON: {exc}") from exc
    else:
        decoded = event_log

    if not isinstance(decoded, list):
        raise EventLogError(f"event log must be a list, got {type(decoded).__name__}")
    return [dict(entry) for entry in decoded]


def replay_rtmrs(event_log: Union[str, Sequence[Mapping[str, Any]]]) -> dict[int, bytes]:
    """
    Recompute RTMR0..RTMR3 by folding the event log.

    Returns:
        Mapping of IMR index to its 48-byte replayed value.
    """
    entries = parse_event_log(event_log)
    registers = {index: bytes(_DIGEST_SIZE) for index in range(_RTMR_COUNT)}

    for position, entry in enumerate(entries):
        imr = entry.get("imr")
        if not isinstance(imr, int):
            raise EventLogError(f"event {position} has a non-integer imr: {imr!r}")
        if imr not in registers:
            # IMRs outside 0..3 are not RTMRs (MRTD is measured differently and
            # is not extended by the event log), so they are not replayable here.
            continue

        digest_hex = entry.get("digest", "")
        try:
            digest = bytes.fromhex(digest_hex)
        except (TypeError, ValueError) as exc:
            raise EventLogError(f"event {position} has a non-hex digest: {digest_hex!r}") from exc

        if len(digest) != _DIGEST_SIZE:
            raise EventLogError(
                f"event {position} digest is {len(digest)} bytes, expected {_DIGEST_SIZE} (SHA-384)"
            )

        registers[imr] = hashlib.sha384(registers[imr] + digest).digest()

    return registers


def verify_event_log(
    quote: Union[str, bytes, TdxQuote],
    event_log: Union[str, Sequence[Mapping[str, Any]]],
) -> dict[int, bytes]:
    """
    Assert that an event log replays to the RTMRs the quote attests to.

    Raises:
        EventLogError: naming the first register that disagreed. A mismatch means
            the log was altered or belongs to a different boot, and every value
            derived from it — including the compose hash — must be discarded.

    Returns:
        The replayed registers, on success.
    """
    parsed = quote if isinstance(quote, TdxQuote) else parse_quote(quote)
    replayed = replay_rtmrs(event_log)

    attested = {0: parsed.rtmr0, 1: parsed.rtmr1, 2: parsed.rtmr2, 3: parsed.rtmr3}
    for index, expected in attested.items():
        if replayed[index] != expected:
            raise EventLogError(
                f"event log does not reproduce RTMR{index}: replayed "
                f"{replayed[index].hex()}, quote attests {expected.hex()}. "
                "The log has been altered or does not belong to this quote."
            )

    return replayed


def find_event_payload(
    event_log: Union[str, Sequence[Mapping[str, Any]]],
    event_name: str,
    imr: int = 3,
) -> str:
    """
    Extract a single named event payload from the log.

    Requires exactly one match. A duplicate `compose-hash` entry would let a
    caller append a second, attacker-chosen value after the real one and hope
    the reader takes the wrong one, so ambiguity is rejected rather than
    resolved by position.
    """
    entries = parse_event_log(event_log)
    matches = [
        entry.get("event_payload", "")
        for entry in entries
        if entry.get("event") == event_name and entry.get("imr") == imr
    ]

    if not matches:
        raise EventLogError(f"event log contains no {event_name!r} entry for IMR{imr}")
    if len(matches) > 1:
        raise EventLogError(
            f"event log contains {len(matches)} {event_name!r} entries for IMR{imr}; "
            "refusing to guess which one is authoritative"
        )

    payload = matches[0]
    if not payload:
        raise EventLogError(f"{event_name!r} entry has an empty payload")
    return payload


def compose_hash_from_event_log(
    event_log: Union[str, Sequence[Mapping[str, Any]]],
) -> str:
    """
    Recover the attested compose hash.

    Only trustworthy after `verify_event_log` has confirmed the log replays to
    the quote's RTMR3. Call them together, in that order.
    """
    payload = find_event_payload(event_log, EVENT_COMPOSE_HASH, imr=3)
    if len(payload) != 64:
        raise EventLogError(
            f"compose-hash payload is {len(payload)} hex chars, expected 64 (32 bytes)"
        )
    bytes.fromhex(payload)  # validates; raises ValueError on bad input
    return payload


def collect_boot_events(
    event_log: Union[str, Sequence[Mapping[str, Any]]],
    names: Iterable[str] = (
        EVENT_APP_ID,
        EVENT_COMPOSE_HASH,
        EVENT_INSTANCE_ID,
        EVENT_OS_IMAGE_HASH,
    ),
) -> dict[str, str]:
    """Gather the named IMR3 boot events into a dict, skipping any that are absent."""
    result: dict[str, str] = {}
    for name in names:
        try:
            result[name] = find_event_payload(event_log, name, imr=3)
        except EventLogError:
            continue
    return result
