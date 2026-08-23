"""
Tests for the SLM allocation layer.

The Ollama transport is replaced at `quant.model._chat`, which exists as a
separate function for exactly this reason. The previous tests patched
`quant.model.ollama` and asserted on `ollama.chat`, but the code calls
`ollama.Client(host=...).chat(...)` — so the assertions were checking a call
that never happened, and the mock's auto-created attributes made them pass.
"""

import json
from unittest.mock import patch

import pytest

from quant.model import (
    SLMError,
    SYSTEM_PROMPT,
    _MAX_RETRIES,
    normalise_allocations,
    query_slm,
    validate_allocation,
)


EXPECTED_SYMBOLS = ["WETH", "USDC"]

VALID_ALLOCATION = {
    "allocations": {"WETH": 0.6, "USDC": 0.4},
    "rationale": "WETH shows bullish momentum with an SMA crossover.",
    "confidence": 0.75,
}

SAMPLE_SIGNALS = {
    "WETH": {
        "close": 2050.5,
        "sma_short": 2040.0,
        "sma_long": 2020.0,
        "sma_crossover": "bullish",
        "zscore": 0.45,
        "momentum": "mild_up",
        "candle_count": 30,
    },
    "USDC": {
        "close": 1.0001,
        "sma_short": 1.0,
        "sma_long": 1.0,
        "sma_crossover": "neutral",
        "zscore": 0.01,
        "momentum": "neutral",
        "candle_count": 30,
    },
}


class TestValidateAllocation:
    def test_valid_passes(self):
        assert validate_allocation(VALID_ALLOCATION, EXPECTED_SYMBOLS) == (True, "valid")

    @pytest.mark.parametrize("missing", ["allocations", "rationale", "confidence"])
    def test_missing_required_key(self, missing):
        payload = {k: v for k, v in VALID_ALLOCATION.items() if k != missing}
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert f"Missing required key: {missing}" in reason

    def test_missing_symbol(self):
        payload = dict(VALID_ALLOCATION, allocations={"WETH": 1.0})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "Missing allocation for symbol: USDC" in reason

    def test_rejects_non_whitelisted_asset(self):
        # An allocation the vault could never act on. Silently dropping it would
        # change the effective split without anyone noticing.
        payload = dict(VALID_ALLOCATION, allocations={"WETH": 0.5, "USDC": 0.3, "DOGE": 0.2})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "non-whitelisted" in reason
        assert "DOGE" in reason

    @pytest.mark.parametrize("bad", [-0.1, 1.5])
    def test_allocation_out_of_range(self, bad):
        payload = dict(VALID_ALLOCATION, allocations={"WETH": bad, "USDC": 0.4})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "out of range" in reason

    def test_sum_far_from_one_rejected(self):
        payload = dict(VALID_ALLOCATION, allocations={"WETH": 0.3, "USDC": 0.3})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "sum to" in reason

    def test_sum_within_tolerance_accepted(self):
        payload = dict(VALID_ALLOCATION, allocations={"WETH": 0.52, "USDC": 0.50})
        ok, _ = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is True

    def test_confidence_out_of_range(self):
        payload = dict(VALID_ALLOCATION, confidence=1.5)
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "confidence out of range" in reason

    def test_empty_rationale_rejected(self):
        payload = dict(VALID_ALLOCATION, rationale="   ")
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "rationale" in reason

    def test_non_numeric_allocation_rejected(self):
        payload = dict(VALID_ALLOCATION, allocations={"WETH": "half", "USDC": 0.5})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "not a number" in reason

    def test_boolean_is_not_a_number(self):
        # bool is a subclass of int in Python; True would otherwise pass as 1.0.
        payload = dict(VALID_ALLOCATION, allocations={"WETH": True, "USDC": 0.0})
        ok, reason = validate_allocation(payload, EXPECTED_SYMBOLS)
        assert ok is False
        assert "not a number" in reason


class TestNormalise:
    def test_sums_to_exactly_one(self):
        result = normalise_allocations(dict(VALID_ALLOCATION, allocations={"WETH": 0.52, "USDC": 0.50}))
        assert abs(sum(result["allocations"].values()) - 1.0) < 1e-9

    def test_preserves_relative_weights(self):
        result = normalise_allocations(dict(VALID_ALLOCATION, allocations={"WETH": 0.6, "USDC": 0.4}))
        assert result["allocations"]["WETH"] == pytest.approx(0.6, abs=1e-6)

    def test_does_not_mutate_input(self):
        original = dict(VALID_ALLOCATION, allocations={"WETH": 0.52, "USDC": 0.50})
        snapshot = json.dumps(original, sort_keys=True)
        normalise_allocations(original)
        assert json.dumps(original, sort_keys=True) == snapshot


class TestQuerySLM:
    def test_valid_response_is_returned_normalised(self):
        with patch("quant.model._chat", return_value=json.dumps(VALID_ALLOCATION)) as chat:
            result = query_slm(SAMPLE_SIGNALS)

        assert chat.call_count == 1
        assert set(result["allocations"]) == {"WETH", "USDC"}
        assert abs(sum(result["allocations"].values()) - 1.0) < 1e-9

    def test_retries_on_invalid_json_then_succeeds(self):
        responses = ["not json at all", "{broken json", json.dumps(VALID_ALLOCATION)]
        with patch("quant.model._chat", side_effect=responses) as chat:
            result = query_slm(SAMPLE_SIGNALS)

        assert chat.call_count == 3
        assert result["allocations"]["WETH"] == pytest.approx(0.6, abs=1e-6)

    def test_retries_on_schema_violation(self):
        responses = [
            json.dumps({"allocations": {"WETH": 1.0}, "rationale": "one asset", "confidence": 0.5}),
            json.dumps(VALID_ALLOCATION),
        ]
        with patch("quant.model._chat", side_effect=responses) as chat:
            result = query_slm(SAMPLE_SIGNALS)

        assert chat.call_count == 2
        assert "USDC" in result["allocations"]

    def test_retry_feeds_the_failure_reason_back(self):
        # A blind resample wastes an attempt. The rejection reason should reach
        # the model so the next attempt can be corrective.
        responses = [
            json.dumps({"allocations": {"WETH": 1.0}, "rationale": "one asset", "confidence": 0.5}),
            json.dumps(VALID_ALLOCATION),
        ]
        with patch("quant.model._chat", side_effect=responses) as chat:
            query_slm(SAMPLE_SIGNALS)

        second_call_messages = chat.call_args_list[1].args[0]
        follow_up = second_call_messages[-1]["content"]
        assert "rejected" in follow_up
        assert "USDC" in follow_up

    def test_raises_after_max_retries(self):
        with patch("quant.model._chat", return_value="I am not JSON") as chat:
            with pytest.raises(SLMError, match="no valid allocation"):
                query_slm(SAMPLE_SIGNALS)

        assert chat.call_count == _MAX_RETRIES

    def test_transport_failure_is_retried_then_raises(self):
        with patch("quant.model._chat", side_effect=ConnectionError("ollama is down")) as chat:
            with pytest.raises(SLMError, match="Ollama call failed"):
                query_slm(SAMPLE_SIGNALS)

        assert chat.call_count == _MAX_RETRIES

    def test_empty_signals_rejected_without_calling_the_model(self):
        with patch("quant.model._chat") as chat:
            with pytest.raises(SLMError, match="no signals"):
                query_slm({})
        chat.assert_not_called()

    def test_system_prompt_is_sent_verbatim(self):
        with patch("quant.model._chat", return_value=json.dumps(VALID_ALLOCATION)) as chat:
            query_slm(SAMPLE_SIGNALS)

        messages = chat.call_args.args[0]
        assert messages[0]["role"] == "system"
        assert messages[0]["content"] == SYSTEM_PROMPT

    def test_model_receives_signals_not_raw_prices(self):
        with patch("quant.model._chat", return_value=json.dumps(VALID_ALLOCATION)) as chat:
            query_slm(SAMPLE_SIGNALS)

        user_message = chat.call_args.args[0][1]
        assert user_message["role"] == "user"
        for field in ("sma_short", "sma_crossover", "zscore", "momentum"):
            assert field in user_message["content"]

        # The message is the signal JSON followed by the budget constraint, so
        # parse the JSON block rather than the whole string. Asserting on the
        # entire body would break on any change to the instruction text while
        # testing nothing about the property that matters.
        payload = json.loads(user_message["content"].split("\n\n", 1)[0])
        assert "open" not in payload["WETH"]
        assert "close" in payload["WETH"]

    def test_user_message_states_the_budget_constraint(self):
        """A 1B model cannot divide 1 by the asset count on its own; with five
        assets it returned 0.25 each and repeated it on every retry."""
        with patch("quant.model._chat", return_value=json.dumps(VALID_ALLOCATION)):
            query_slm(SAMPLE_SIGNALS)

    def test_equal_weight_hint_matches_the_asset_count(self):
        from quant.model import _build_user_message

        symbols = ["A", "B", "C", "D", "E"]
        message = _build_user_message({s: {} for s in symbols}, symbols)

        assert "exactly these 5 assets" in message
        assert "add up to exactly 1.0" in message
        # 1/5 spelled out, because the model cannot compute it.
        assert "0.2" in message
        for symbol in symbols:
            assert symbol in message
