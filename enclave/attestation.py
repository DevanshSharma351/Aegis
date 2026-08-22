"""
Aegis Enclave -- dstack TEE attestation.

Produces the evidence the rest of the protocol depends on:

  1. A deterministic hash of the rebalance decision.
  2. A TDX quote with that hash bound into its report_data field.
  3. The enclave code measurement, derived from the TD report registers.

Nothing here decides whether the attestation is *trustworthy* -- that judgement
belongs to the oracle, which re-derives everything from the quote bytes rather
than believing what this module reports alongside them. The split is
deliberate: an enclave asserting its own integrity is not evidence.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Mapping

from dstack_sdk import DstackClient

from aegis_tdx import (
    compute_decision_hash,
    measurement_from_quote,
    measurement_from_tcb_info,
    parse_quote,
)

SOURCE_SIMULATOR = "simulator"
SOURCE_HARDWARE = "hardware-tdx"


def attestation_source() -> str:
    """
    Report whether quotes come from the dstack simulator or real TDX hardware.

    This value is threaded all the way to the frontend badge and into
    deployed.json. A simulator quote carries a canned attestation blob with
    report_data patched in: it exercises every code path but proves nothing
    about hardware, so the distinction must never be left to inference. It is
    stated explicitly at every layer.

    Resolution order:
      AEGIS_ATTESTATION_SOURCE   explicit override, wins if set
      DSTACK_SIMULATOR_ENDPOINT  present implies the simulator
      otherwise                  assume real hardware
    """
    override = os.environ.get("AEGIS_ATTESTATION_SOURCE", "").strip()
    if override:
        return override
    if os.environ.get("DSTACK_SIMULATOR_ENDPOINT", "").strip():
        return SOURCE_SIMULATOR
    return SOURCE_HARDWARE


def _client() -> DstackClient:
    """
    Build a dstack client.

    DstackClient resolves its endpoint from DSTACK_SIMULATOR_ENDPOINT when set,
    and otherwise probes the well-known guest agent socket paths. The enclave
    therefore needs no branch of its own: the identical code path runs against
    the simulator container and against a real dstack CVM.
    """
    return DstackClient()


@dataclass(frozen=True)
class EnclaveIdentity:
    """The enclave code identity, as reported by the guest agent."""

    measurement: bytes
    mrtd: str
    rtmr0: str
    rtmr1: str
    rtmr2: str
    rtmr3: str
    compose_hash: str
    app_id: str
    instance_id: str
    os_image_hash: str
    source: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "measurement": "0x" + self.measurement.hex(),
            "mrtd": self.mrtd,
            "rtmr0": self.rtmr0,
            "rtmr1": self.rtmr1,
            "rtmr2": self.rtmr2,
            "rtmr3": self.rtmr3,
            "compose_hash": self.compose_hash,
            "app_id": self.app_id,
            "instance_id": self.instance_id,
            "os_image_hash": self.os_image_hash,
            "source": self.source,
        }


def get_enclave_identity() -> EnclaveIdentity:
    """
    Read this enclave measurement registers from the guest agent.

    Used by GET /measurement, which is how the deploy script learns the value to
    burn into AttestationVerifier.expectedMeasurement, and how
    verify_deployment.sh detects that a rebuild has drifted from the deployed
    constant.
    """
    info = _client().info()
    tcb = info.tcb_info

    # compose_hash is on the top-level response for every dstack version; 0.5.x
    # mirrors it into tcb_info as well. Prefer top-level, fall back, so the
    # enclave works across both.
    compose_hash = info.compose_hash or getattr(tcb, "compose_hash", "")
    if not compose_hash:
        raise RuntimeError(
            "dstack guest agent returned no compose_hash. The measurement cannot "
            "be derived without it; refusing to report a partial identity."
        )

    measurement = measurement_from_tcb_info(
        {"mrtd": tcb.mrtd, "rtmr0": tcb.rtmr0, "rtmr1": tcb.rtmr1, "rtmr2": tcb.rtmr2},
        compose_hash,
    )

    return EnclaveIdentity(
        measurement=measurement,
        mrtd=tcb.mrtd,
        rtmr0=tcb.rtmr0,
        rtmr1=tcb.rtmr1,
        rtmr2=tcb.rtmr2,
        rtmr3=tcb.rtmr3,
        compose_hash=compose_hash,
        app_id=info.app_id,
        instance_id=info.instance_id,
        os_image_hash=info.os_image_hash or getattr(tcb, "os_image_hash", ""),
        source=attestation_source(),
    )


def attest_decision(decision: Mapping[str, Any]) -> dict[str, Any]:
    """
    Bind a rebalance decision to a TDX quote.

    Steps:
      1. Hash the decision (keccak256 over canonical JSON).
      2. Ask the guest agent for a quote with that hash as report_data.
      3. Re-parse the returned quote and assert report_data actually came back
         bound. A guest agent that ignored the request would otherwise produce a
         quote attesting nothing about this decision, and the failure would
         surface only downstream as an opaque oracle rejection.
      4. Derive the measurement from the quote bytes and cross-check it against
         the guest agent Info response.

    Returns a dict carrying the quote, decision hash, measurement, event log,
    and attestation source.
    """
    decision_hash = compute_decision_hash(decision)

    client = _client()
    quote_response = client.get_quote(decision_hash)

    raw_quote = quote_response.quote
    quote_hex = raw_quote if isinstance(raw_quote, str) else bytes(raw_quote).hex()
    if quote_hex.startswith("0x"):
        quote_hex = quote_hex[2:]

    parsed = parse_quote(quote_hex)

    # Step 3. This single assertion is what makes the quote evidence about THIS
    # decision rather than evidence in general.
    if parsed.report_data_32 != decision_hash:
        raise RuntimeError(
            "TDX quote report_data does not match the decision hash: expected "
            + decision_hash.hex()
            + ", quote carries "
            + parsed.report_data_32.hex()
            + ". The guest agent did not bind the requested report_data, so the "
            "quote proves nothing about this decision."
        )

    identity = get_enclave_identity()

    # Step 4. Quote-derived and agent-reported measurements come from two
    # different code paths on the agent side. Disagreement means the agent is
    # internally inconsistent and its measurement cannot be trusted.
    measurement = measurement_from_quote(parsed, identity.compose_hash)
    if measurement != identity.measurement:
        raise RuntimeError(
            "Measurement derived from the quote does not match the guest agent "
            "Info response: " + measurement.hex() + " vs " + identity.measurement.hex()
            + ". Refusing to emit an attestation."
        )

    return {
        "quote": "0x" + quote_hex,
        "decision_hash": "0x" + decision_hash.hex(),
        "measurement": "0x" + measurement.hex(),
        "compose_hash": identity.compose_hash,
        "event_log": quote_response.event_log or "",
        "source": identity.source,
        "generated_at": int(time.time()),
    }
