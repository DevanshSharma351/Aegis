"""
Tests for the attestation layer.

Split into two groups:

  - Pure tests over the shared measurement/quote code, which run anywhere.
  - Integration tests against a live dstack guest agent, skipped unless
    DSTACK_SIMULATOR_ENDPOINT is set.

The integration tests are worth having because the properties they check —
that report_data comes back bound, that two independent derivations of the
measurement agree — cannot be verified against a mock. A mock would return
whatever the mock was told to return.
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from aegis_tdx import (
    compute_decision_hash,
    compute_measurement,
    measurement_from_quote,
    parse_quote,
    verify_event_log,
)
from aegis_tdx.quote import QuoteParseError

import attestation


SAMPLE_DECISION = {
    "allocations": {"WETH": 0.6, "USDC": 0.4},
    "rationale": "WETH shows bullish momentum on the SMA crossover.",
    "confidence": 0.75,
}

# Same content, different key order. Canonical serialisation must hash it
# identically, or the enclave and the oracle would disagree about what was
# decided purely because of dict ordering.
SAMPLE_DECISION_REORDERED = {
    "confidence": 0.75,
    "rationale": "WETH shows bullish momentum on the SMA crossover.",
    "allocations": {"USDC": 0.4, "WETH": 0.6},
}

SIMULATOR_AVAILABLE = bool(os.environ.get("DSTACK_SIMULATOR_ENDPOINT"))
requires_simulator = pytest.mark.skipif(
    not SIMULATOR_AVAILABLE,
    reason="DSTACK_SIMULATOR_ENDPOINT is not set",
)


class TestDecisionHash:
    def test_is_32_bytes(self):
        assert len(compute_decision_hash(SAMPLE_DECISION)) == 32

    def test_is_deterministic(self):
        assert compute_decision_hash(SAMPLE_DECISION) == compute_decision_hash(SAMPLE_DECISION)

    def test_is_key_order_independent(self):
        assert compute_decision_hash(SAMPLE_DECISION) == compute_decision_hash(
            SAMPLE_DECISION_REORDERED
        )

    def test_differs_for_different_allocations(self):
        other = dict(SAMPLE_DECISION, allocations={"WETH": 0.61, "USDC": 0.39})
        assert compute_decision_hash(SAMPLE_DECISION) != compute_decision_hash(other)

    def test_differs_for_different_rationale(self):
        # The rationale is part of the attested decision, so changing it must
        # change the hash: otherwise two different published explanations could
        # share one on-chain record.
        other = dict(SAMPLE_DECISION, rationale="Completely different reasoning.")
        assert compute_decision_hash(SAMPLE_DECISION) != compute_decision_hash(other)


class TestMeasurement:
    MRTD = "aa" * 48
    RTMR0 = "bb" * 48
    RTMR1 = "cc" * 48
    RTMR2 = "dd" * 48
    COMPOSE = "ee" * 32

    def test_is_32_bytes(self):
        result = compute_measurement(self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)
        assert len(result) == 32

    def test_accepts_bytes_and_hex_interchangeably(self):
        from_hex = compute_measurement(self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)
        from_bytes = compute_measurement(
            bytes.fromhex(self.MRTD),
            bytes.fromhex(self.RTMR0),
            bytes.fromhex(self.RTMR1),
            bytes.fromhex(self.RTMR2),
            bytes.fromhex(self.COMPOSE),
        )
        assert from_hex == from_bytes

    def test_compose_hash_changes_the_measurement(self):
        # This is the property that makes a rebuilt image fail verification.
        baseline = compute_measurement(self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)
        rebuilt = compute_measurement(self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, "ff" * 32)
        assert baseline != rebuilt

    def test_each_register_changes_the_measurement(self):
        baseline = compute_measurement(self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)
        args = [self.MRTD, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE]

        for index in range(4):
            mutated = list(args)
            mutated[index] = "11" * 48
            assert compute_measurement(*mutated) != baseline, f"register {index} was ignored"

    def test_rejects_wrong_length_register(self):
        with pytest.raises(ValueError, match="must be 48 bytes"):
            compute_measurement("aa" * 32, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)

    def test_rejects_non_hex(self):
        with pytest.raises(ValueError, match="not valid hex"):
            compute_measurement("zz" * 48, self.RTMR0, self.RTMR1, self.RTMR2, self.COMPOSE)


class TestQuoteParsing:
    def test_rejects_truncated_blob(self):
        with pytest.raises(QuoteParseError, match="too short"):
            parse_quote("00" * 100)

    def test_rejects_bad_hex(self):
        with pytest.raises(QuoteParseError, match="not valid hex"):
            parse_quote("nothex" * 200)

    def test_rejects_unsupported_version(self):
        # Version 2 header on an otherwise correctly sized blob.
        blob = bytearray(48 + 584)
        blob[0:2] = (2).to_bytes(2, "little")
        with pytest.raises(QuoteParseError, match="unsupported quote version"):
            parse_quote(bytes(blob))

    def test_rejects_non_tdx_tee_type(self):
        blob = bytearray(48 + 584)
        blob[0:2] = (4).to_bytes(2, "little")
        blob[4:8] = (0).to_bytes(4, "little")  # SGX, not TDX
        with pytest.raises(QuoteParseError, match="not TDX"):
            parse_quote(bytes(blob))


class TestAttestationSource:
    def test_explicit_override_wins(self):
        with patch.dict(os.environ, {"AEGIS_ATTESTATION_SOURCE": "hardware-tdx"}):
            assert attestation.attestation_source() == "hardware-tdx"

    def test_simulator_endpoint_implies_simulator(self):
        env = {"DSTACK_SIMULATOR_ENDPOINT": "/var/run/dstack/dstack.sock"}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("AEGIS_ATTESTATION_SOURCE", None)
            assert attestation.attestation_source() == "simulator"

    def test_defaults_to_hardware(self):
        with patch.dict(os.environ, {}, clear=True):
            assert attestation.attestation_source() == "hardware-tdx"


class TestReportDataBinding:
    """
    The single check that makes a quote evidence about a specific decision.

    A guest agent that ignored the requested report_data would otherwise produce
    a quote attesting nothing in particular, and the failure would surface much
    later as an unexplained oracle rejection.
    """

    def test_raises_when_report_data_does_not_match(self):
        decision_hash = compute_decision_hash(SAMPLE_DECISION)

        # A structurally valid quote carrying somebody else's report_data.
        blob = bytearray(48 + 584)
        blob[0:2] = (4).to_bytes(2, "little")
        blob[4:8] = (0x81).to_bytes(4, "little")
        body_start = 48
        blob[body_start + 520 : body_start + 552] = b"\x99" * 32

        mock_client = MagicMock()
        mock_client.get_quote.return_value = MagicMock(
            quote=bytes(blob).hex(), event_log="[]"
        )

        with patch.object(attestation, "_client", return_value=mock_client):
            with pytest.raises(RuntimeError, match="report_data does not match"):
                attestation.attest_decision(SAMPLE_DECISION)

        assert decision_hash.hex() not in bytes(blob).hex()


@requires_simulator
class TestAgainstLiveGuestAgent:
    def test_identity_is_readable(self):
        identity = attestation.get_enclave_identity()

        assert len(identity.measurement) == 32
        assert len(bytes.fromhex(identity.mrtd)) == 48
        assert len(bytes.fromhex(identity.compose_hash)) == 32

    def test_identity_is_stable_across_calls(self):
        # The measurement is per-build, not per-call. If it moved between calls
        # the on-chain constant could never match.
        assert attestation.get_enclave_identity().measurement == (
            attestation.get_enclave_identity().measurement
        )

    def test_attest_decision_binds_the_decision_hash(self):
        result = attestation.attest_decision(SAMPLE_DECISION)

        expected = compute_decision_hash(SAMPLE_DECISION)
        assert result["decision_hash"] == "0x" + expected.hex()

        parsed = parse_quote(result["quote"])
        assert parsed.report_data_32 == expected

    def test_quote_derived_measurement_matches_the_agent(self):
        # Two independent paths to the same value: the quote's TD report body,
        # and the agent's Info response. Disagreement means the agent is
        # inconsistent and its measurement cannot be trusted.
        result = attestation.attest_decision(SAMPLE_DECISION)
        from_quote = measurement_from_quote(result["quote"], result["compose_hash"])

        assert "0x" + from_quote.hex() == result["measurement"]
        assert result["measurement"] == "0x" + attestation.get_enclave_identity().measurement.hex()

    def test_event_log_replays_to_the_attested_rtmrs(self):
        result = attestation.attest_decision(SAMPLE_DECISION)

        # Raises if the log does not reproduce the quote's registers.
        verify_event_log(result["quote"], result["event_log"])

        assert len(json.loads(result["event_log"])) > 0

    def test_different_decisions_produce_different_report_data(self):
        first = attestation.attest_decision(SAMPLE_DECISION)
        second = attestation.attest_decision(
            dict(SAMPLE_DECISION, allocations={"WETH": 0.3, "USDC": 0.7})
        )

        assert first["decision_hash"] != second["decision_hash"]
        assert parse_quote(first["quote"]).report_data_32 != parse_quote(second["quote"]).report_data_32
        # Same build, so the measurement must not have moved.
        assert first["measurement"] == second["measurement"]
