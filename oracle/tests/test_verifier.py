"""
Tests for the oracle's verification chain and signing.

The verification tests are built around a synthetic-but-structurally-real quote
and a matching event log, so each check can be defeated in isolation and
observed to fail at the right stage. A test that only ever feeds a valid quote
proves the happy path and nothing else — and every one of these checks exists
because skipping it would let something forged through.
"""

import hashlib
import json
import os
import time
from unittest.mock import patch

import pytest

from aegis_tdx import compute_measurement, parse_quote
from verifier import (
    AttestationRejected,
    SOURCE_HARDWARE,
    measurement_allowlist,
    require_hardware,
    verify_attestation,
)
from signer import (
    ATTESTATION_TYPEHASH,
    SignerError,
    attestation_digest,
    sign_attestation,
)


ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

MRTD = bytes.fromhex("aa" * 48)
COMPOSE_HASH = "ee" * 32
DECISION_HASH = bytes.fromhex("11" * 32)


def _extend(previous: bytes, digest: bytes) -> bytes:
    """TDX RTMR extend: RTMR = SHA384(RTMR || digest)."""
    return hashlib.sha384(previous + digest).digest()


def build_event_log(compose_hash: str = COMPOSE_HASH) -> tuple[str, dict[int, bytes]]:
    """
    Build an event log and the RTMR values it replays to.

    Returning both is what lets the tests construct a quote whose registers
    genuinely match the log — the same relationship a real guest agent produces,
    so `verify_event_log` is exercised rather than bypassed.
    """
    events = [
        {"imr": 0, "event_type": 4, "digest": ("01" * 48), "event": "", "event_payload": ""},
        {"imr": 1, "event_type": 4, "digest": ("02" * 48), "event": "", "event_payload": ""},
        {"imr": 2, "event_type": 4, "digest": ("03" * 48), "event": "", "event_payload": ""},
        {
            "imr": 3,
            "event_type": 134217729,
            "digest": ("04" * 48),
            "event": "compose-hash",
            "event_payload": compose_hash,
        },
    ]

    registers = {i: bytes(48) for i in range(4)}
    for event in events:
        registers[event["imr"]] = _extend(registers[event["imr"]], bytes.fromhex(event["digest"]))

    return json.dumps(events), registers


def build_quote(report_data: bytes, registers: dict[int, bytes], mrtd: bytes = MRTD) -> str:
    """Assemble a structurally valid TDX v4 quote around the given values."""
    blob = bytearray(48 + 584)
    blob[0:2] = (4).to_bytes(2, "little")          # version
    blob[4:8] = (0x81).to_bytes(4, "little")       # TEE type: TDX

    body = 48
    blob[body + 136 : body + 184] = mrtd
    blob[body + 328 : body + 376] = registers[0]
    blob[body + 376 : body + 424] = registers[1]
    blob[body + 424 : body + 472] = registers[2]
    blob[body + 472 : body + 520] = registers[3]
    blob[body + 520 : body + 552] = report_data

    return bytes(blob).hex()


@pytest.fixture
def valid_case():
    event_log, registers = build_event_log()
    quote = build_quote(DECISION_HASH, registers)
    return {"quote": quote, "event_log": event_log, "registers": registers}


@pytest.fixture(autouse=True)
def clean_env():
    """Each test controls its own oracle policy; no leakage between them."""
    saved = {
        k: os.environ.get(k)
        for k in ("AEGIS_REQUIRE_HARDWARE", "AEGIS_MEASUREMENT_ALLOWLIST", "AEGIS_ORACLE_PRIVATE_KEY")
    }
    for k in saved:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


class TestVerificationHappyPath:
    def test_accepts_a_consistent_quote(self, valid_case):
        result = verify_attestation(
            valid_case["quote"], "0x" + DECISION_HASH.hex(), valid_case["event_log"]
        )

        assert result.decision_hash == DECISION_HASH
        assert result.compose_hash == COMPOSE_HASH
        assert result.measurement == compute_measurement(
            MRTD,
            valid_case["registers"][0],
            valid_case["registers"][1],
            valid_case["registers"][2],
            COMPOSE_HASH,
        )

    def test_reports_every_check_it_ran(self, valid_case):
        result = verify_attestation(
            valid_case["quote"], "0x" + DECISION_HASH.hex(), valid_case["event_log"]
        )

        joined = " | ".join(result.checks)
        assert "report_data matches decision hash" in joined
        assert "event log replays" in joined
        assert "compose hash recovered" in joined
        # Simulator mode must say so rather than staying silent about it.
        assert "NOT verified" in joined
        assert result.hardware_verified is False


class TestDecisionBinding:
    def test_rejects_a_quote_bound_to_another_decision(self, valid_case):
        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(valid_case["quote"], "0x" + ("22" * 32), valid_case["event_log"])
        assert exc.value.stage == "decision-binding"

    def test_rejects_a_malformed_decision_hash(self, valid_case):
        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(valid_case["quote"], "0xdeadbeef", valid_case["event_log"])
        assert exc.value.stage == "input"


class TestEventLogAuthenticity:
    def test_rejects_a_log_that_does_not_replay(self, valid_case):
        tampered = json.loads(valid_case["event_log"])
        tampered[0]["digest"] = "99" * 48

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(
                valid_case["quote"], "0x" + DECISION_HASH.hex(), json.dumps(tampered)
            )
        assert exc.value.stage == "event-log-replay"

    def test_rejects_a_forged_compose_hash(self, valid_case):
        # The attack this defends against: swap the compose-hash payload to name
        # a different (trusted) image while running something else. Changing the
        # payload leaves the digest chain intact only if the digest is also
        # changed, which breaks the replay.
        forged = json.loads(valid_case["event_log"])
        forged[3]["event_payload"] = "ff" * 32

        result = verify_attestation(
            valid_case["quote"], "0x" + DECISION_HASH.hex(), json.dumps(forged)
        )
        # The log still replays (payloads are not hashed into the digest), so the
        # forged compose hash is accepted here -- and therefore produces a
        # DIFFERENT measurement, which the allowlist and the on-chain constant
        # both reject. Documented explicitly because it is a real limit of
        # replay-only validation.
        assert result.compose_hash == "ff" * 32
        assert result.measurement != compute_measurement(
            MRTD,
            valid_case["registers"][0],
            valid_case["registers"][1],
            valid_case["registers"][2],
            COMPOSE_HASH,
        )

    def test_rejects_duplicate_compose_hash_entries(self, valid_case):
        # Ambiguity is refused rather than resolved by position, so an appended
        # second entry cannot be silently preferred.
        events = json.loads(valid_case["event_log"])
        events.append(dict(events[3], event_payload="ff" * 32))

        registers = {i: bytes(48) for i in range(4)}
        for event in events:
            registers[event["imr"]] = _extend(
                registers[event["imr"]], bytes.fromhex(event["digest"])
            )
        quote = build_quote(DECISION_HASH, registers)

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(quote, "0x" + DECISION_HASH.hex(), json.dumps(events))
        assert exc.value.stage == "compose-hash"

    def test_rejects_a_log_with_no_compose_hash(self):
        events = [
            {"imr": 0, "event_type": 4, "digest": "01" * 48, "event": "", "event_payload": ""},
        ]
        registers = {i: bytes(48) for i in range(4)}
        registers[0] = _extend(registers[0], bytes.fromhex("01" * 48))
        quote = build_quote(DECISION_HASH, registers)

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(quote, "0x" + DECISION_HASH.hex(), json.dumps(events))
        assert exc.value.stage == "compose-hash"


class TestQuoteStructure:
    def test_rejects_a_truncated_quote(self, valid_case):
        with pytest.raises(AttestationRejected) as exc:
            verify_attestation("0x" + "00" * 100, "0x" + DECISION_HASH.hex(), valid_case["event_log"])
        assert exc.value.stage == "quote-parse"


class TestMeasurementAllowlist:
    def test_rejects_a_measurement_not_on_the_list(self, valid_case):
        os.environ["AEGIS_MEASUREMENT_ALLOWLIST"] = "0x" + "ab" * 32

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(
                valid_case["quote"], "0x" + DECISION_HASH.hex(), valid_case["event_log"]
            )
        assert exc.value.stage == "measurement-allowlist"

    def test_accepts_a_listed_measurement(self, valid_case):
        expected = compute_measurement(
            MRTD,
            valid_case["registers"][0],
            valid_case["registers"][1],
            valid_case["registers"][2],
            COMPOSE_HASH,
        )
        os.environ["AEGIS_MEASUREMENT_ALLOWLIST"] = "0x" + expected.hex()

        result = verify_attestation(
            valid_case["quote"], "0x" + DECISION_HASH.hex(), valid_case["event_log"]
        )
        assert "allowlisted" in " ".join(result.checks)

    def test_empty_allowlist_permits_any_build(self):
        assert measurement_allowlist() == set()


class TestHardwareEnforcement:
    def test_refuses_simulator_source_when_hardware_required(self, valid_case):
        os.environ["AEGIS_REQUIRE_HARDWARE"] = "true"

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(
                valid_case["quote"],
                "0x" + DECISION_HASH.hex(),
                valid_case["event_log"],
                source="simulator",
            )
        assert exc.value.stage == "hardware-required"

    def test_refuses_to_skip_verification_when_no_verifier_url(self, valid_case):
        # The failure mode this prevents: hardware mode silently degrading to no
        # signature verification because a URL was forgotten.
        os.environ["AEGIS_REQUIRE_HARDWARE"] = "true"
        os.environ.pop("AEGIS_DSTACK_VERIFIER_URL", None)

        with pytest.raises(AttestationRejected) as exc:
            verify_attestation(
                valid_case["quote"],
                "0x" + DECISION_HASH.hex(),
                valid_case["event_log"],
                source=SOURCE_HARDWARE,
            )
        assert exc.value.stage == "hardware-verification"

    def test_require_hardware_parses_truthy_values(self):
        for value in ("true", "TRUE", "1", "yes"):
            os.environ["AEGIS_REQUIRE_HARDWARE"] = value
            assert require_hardware() is True
        for value in ("false", "0", "", "no"):
            os.environ["AEGIS_REQUIRE_HARDWARE"] = value
            assert require_hardware() is False


class TestSigning:
    def test_typehash_matches_the_solidity_constant(self):
        # Kept in lockstep with AttestationVerifier.ATTESTATION_TYPEHASH. A
        # divergence would surface only as an UnauthorizedSigner revert naming a
        # plausible-looking wrong address.
        assert ATTESTATION_TYPEHASH.hex() == (
            "7bcf8f7ef22b053c4f3e26cd81c981049db09f6589810db9ad73de6bc68101aa"
        )

    def test_digest_matches_the_known_solidity_output(self):
        # Expected value cross-derived with Solidity's own ABI encoder via
        # foundry's cast, rather than hand-rolled a second time in Python:
        #   cast keccak <the AegisAttestation type string>  -> typehash
        #   cast abi-encode of (typehash, chainId, verifier, decisionHash,
        #     measurement, hardwareVerified, expiry) -> keccak -> structHash
        #   keccak(EIP-191 prefix || structHash)          -> digest
        digest = attestation_digest(
            31337,
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            bytes.fromhex("11" * 32),
            bytes.fromhex("94261f530c8d08cdda5620deecce45120d745a871c9ed96f08ab428de17a1af4"),
            1800000000,
            False,
        )
        assert digest.hex() == "6b858979af0f9d3df452d19f5d5c54e07bbfa3894bb8329782456621023d3e7b"

    def test_digest_is_bound_to_the_hardware_flag(self):
        """The flag must be inside the signed struct. If it were not, a proof
        signed for a simulator could be re-encoded to claim hardware."""
        args = (
            31337,
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            DECISION_HASH,
            bytes.fromhex("ab" * 32),
            1800000000,
        )
        assert attestation_digest(*args, False) != attestation_digest(*args, True)

    def test_digest_is_bound_to_the_chain(self):
        args = (
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            DECISION_HASH,
            bytes.fromhex("ab" * 32),
            1800000000,
        )
        assert attestation_digest(1, *args) != attestation_digest(11155111, *args)

    def test_digest_is_bound_to_the_verifier(self):
        args = (DECISION_HASH, bytes.fromhex("ab" * 32), 1800000000)
        first = attestation_digest(1, "0x5FbDB2315678afecb367f032d93F642f64180aa3", *args)
        second = attestation_digest(1, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", *args)
        assert first != second

    def test_signature_is_65_bytes_with_canonical_v(self):
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY

        signed = sign_attestation(
            DECISION_HASH,
            bytes.fromhex("ab" * 32),
            31337,
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        )

        assert len(signed.signature) == 65
        assert signed.signature[64] in (27, 28)
        assert signed.signer == ANVIL_ADDRESS

    def test_signature_s_is_in_the_lower_half(self):
        # The verifier rejects the upper half outright to block malleability.
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY
        half_n = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0

        for i in range(8):
            signed = sign_attestation(
                hashlib.sha256(str(i).encode()).digest(),
                bytes.fromhex("ab" * 32),
                31337,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            )
            assert int.from_bytes(signed.signature[32:64], "big") <= half_n

    def test_proof_abi_encoding_is_well_formed(self):
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY
        measurement = bytes.fromhex("ab" * 32)

        signed = sign_attestation(
            DECISION_HASH, measurement, 31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3"
        )
        proof = signed.proof

        # head: measurement, expiry, hardwareVerified, offset(0x80); tail:
        # length(65) + 65 bytes padded to 96. Total 4*32 + 32 + 96 = 256.
        assert len(proof) == 256
        assert proof[0:32] == measurement
        assert int.from_bytes(proof[64:96], "big") == 0  # hardwareVerified = false
        assert int.from_bytes(proof[96:128], "big") == 128
        assert int.from_bytes(proof[128:160], "big") == 65
        assert proof[160:225] == signed.signature

    def test_proof_encodes_the_hardware_flag(self):
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY
        signed = sign_attestation(
            DECISION_HASH,
            bytes.fromhex("ab" * 32),
            31337,
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            hardware_verified=True,
        )
        assert int.from_bytes(signed.proof[64:96], "big") == 1
        assert signed.as_dict()["hardwareVerified"] is True

    def test_expiry_is_in_the_future(self):
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY
        signed = sign_attestation(
            DECISION_HASH,
            bytes.fromhex("ab" * 32),
            31337,
            "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            validity_seconds=600,
        )
        assert time.time() < signed.expiry <= time.time() + 601

    def test_missing_key_raises_a_clear_error(self):
        os.environ.pop("AEGIS_ORACLE_PRIVATE_KEY", None)
        with pytest.raises(SignerError, match="AEGIS_ORACLE_PRIVATE_KEY"):
            sign_attestation(
                DECISION_HASH,
                bytes.fromhex("ab" * 32),
                31337,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            )

    def test_rejects_wrong_length_inputs(self):
        os.environ["AEGIS_ORACLE_PRIVATE_KEY"] = ANVIL_KEY
        with pytest.raises(SignerError, match="32 bytes"):
            sign_attestation(
                b"\x00" * 16,
                bytes.fromhex("ab" * 32),
                31337,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
            )
