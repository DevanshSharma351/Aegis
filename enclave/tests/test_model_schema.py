"""
Tests for the SLM allocation layer (quant/model.py).

These tests verify that:
- The SLM output schema is validated correctly
- Valid outputs pass validation
- Invalid outputs are rejected
- The retry logic works as expected

NOTE: These tests mock the Ollama call to avoid requiring a running
Ollama instance. They test the validation and retry logic, not the
SLM inference itself. To test actual inference, run the enclave
with Ollama running locally.
"""

import json
from unittest.mock import patch, MagicMock

import pytest

from quant.model import validate_allocation, query_slm, _MAX_RETRIES


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

EXPECTED_SYMBOLS = ["WETH", "USDC"]

VALID_ALLOCATION = {
    "allocations": {"WETH": 0.6, "USDC": 0.4},
    "rationale": "WETH shows bullish momentum with SMA crossover.",
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


# ---------------------------------------------------------------------------
# Validation tests
# ---------------------------------------------------------------------------

class TestValidateAllocation:
    def test_valid_allocation_passes(self):
        valid, reason = validate_allocation(VALID_ALLOCATION, EXPECTED_SYMBOLS)
        assert valid is True
        assert reason == "valid"

    def test_missing_allocations_key(self):
        invalid = {"rationale": "test", "confidence": 0.5}
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "Missing required key: allocations" in reason

    def test_missing_rationale_key(self):
        invalid = {"allocations": {"WETH": 0.5, "USDC": 0.5}, "confidence": 0.5}
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "Missing required key: rationale" in reason

    def test_missing_confidence_key(self):
        invalid = {
            "allocations": {"WETH": 0.5, "USDC": 0.5},
            "rationale": "test",
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "Missing required key: confidence" in reason

    def test_missing_symbol_in_allocations(self):
        invalid = {
            "allocations": {"WETH": 1.0},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "Missing allocation for symbol: USDC" in reason

    def test_allocation_out_of_range_negative(self):
        invalid = {
            "allocations": {"WETH": -0.1, "USDC": 1.1},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "out of range" in reason

    def test_allocation_out_of_range_above_one(self):
        invalid = {
            "allocations": {"WETH": 1.5, "USDC": 0.5},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "out of range" in reason

    def test_allocations_dont_sum_to_one(self):
        invalid = {
            "allocations": {"WETH": 0.3, "USDC": 0.3},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "sum to" in reason

    def test_allocations_sum_within_tolerance(self):
        """Tolerance is 0.05 — this should pass."""
        marginal = {
            "allocations": {"WETH": 0.52, "USDC": 0.50},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, _ = validate_allocation(marginal, EXPECTED_SYMBOLS)
        assert valid is True

    def test_confidence_out_of_range(self):
        invalid = {
            "allocations": {"WETH": 0.5, "USDC": 0.5},
            "rationale": "test",
            "confidence": 1.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "confidence out of range" in reason

    def test_empty_rationale(self):
        invalid = {
            "allocations": {"WETH": 0.5, "USDC": 0.5},
            "rationale": "",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "rationale" in reason

    def test_non_numeric_allocation(self):
        invalid = {
            "allocations": {"WETH": "half", "USDC": 0.5},
            "rationale": "test",
            "confidence": 0.5,
        }
        valid, reason = validate_allocation(invalid, EXPECTED_SYMBOLS)
        assert valid is False
        assert "not a number" in reason


# ---------------------------------------------------------------------------
# SLM query tests (mocked)
# ---------------------------------------------------------------------------

class TestQuerySLM:
    def _mock_ollama_response(self, content: str):
        """Create a mock Ollama response object."""
        mock_resp = MagicMock()
        mock_resp.message.content = content
        return mock_resp

    @patch("quant.model.ollama")
    def test_valid_response_returns_allocation(self, mock_ollama):
        mock_ollama.chat.return_value = self._mock_ollama_response(
            json.dumps(VALID_ALLOCATION)
        )
        result = query_slm(SAMPLE_SIGNALS)
        assert result["allocations"]["WETH"] == 0.6
        assert result["allocations"]["USDC"] == 0.4
        assert "rationale" in result
        assert "confidence" in result

    @patch("quant.model.ollama")
    def test_retries_on_invalid_json(self, mock_ollama):
        """First two calls return invalid JSON, third returns valid."""
        mock_ollama.chat.side_effect = [
            self._mock_ollama_response("not json at all"),
            self._mock_ollama_response("{broken json"),
            self._mock_ollama_response(json.dumps(VALID_ALLOCATION)),
        ]
        result = query_slm(SAMPLE_SIGNALS)
        assert result["allocations"]["WETH"] == 0.6
        assert mock_ollama.chat.call_count == 3

    @patch("quant.model.ollama")
    def test_retries_on_schema_violation(self, mock_ollama):
        """First call has missing symbol, second is valid."""
        missing_symbol = {
            "allocations": {"WETH": 1.0},
            "rationale": "only one asset",
            "confidence": 0.5,
        }
        mock_ollama.chat.side_effect = [
            self._mock_ollama_response(json.dumps(missing_symbol)),
            self._mock_ollama_response(json.dumps(VALID_ALLOCATION)),
        ]
        result = query_slm(SAMPLE_SIGNALS)
        assert "USDC" in result["allocations"]
        assert mock_ollama.chat.call_count == 2

    @patch("quant.model.ollama")
    def test_raises_after_max_retries(self, mock_ollama):
        """All retries return invalid output → raises ValueError."""
        mock_ollama.chat.return_value = self._mock_ollama_response(
            "I am not JSON"
        )
        with pytest.raises(ValueError, match="failed to produce valid output"):
            query_slm(SAMPLE_SIGNALS)
        assert mock_ollama.chat.call_count == _MAX_RETRIES

    @patch("quant.model.ollama")
    def test_system_prompt_is_sent(self, mock_ollama):
        """Verify the exact system prompt from the spec is used."""
        mock_ollama.chat.return_value = self._mock_ollama_response(
            json.dumps(VALID_ALLOCATION)
        )
        query_slm(SAMPLE_SIGNALS)
        call_args = mock_ollama.chat.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        system_msg = messages[0]
        assert system_msg["role"] == "system"
        assert "quantitative portfolio rebalancing engine" in system_msg["content"]
        assert "Do not include any text outside the JSON object" in system_msg["content"]

    @patch("quant.model.ollama")
    def test_user_message_contains_signals(self, mock_ollama):
        """Verify the SLM receives signal data (not raw prices) as input."""
        mock_ollama.chat.return_value = self._mock_ollama_response(
            json.dumps(VALID_ALLOCATION)
        )
        query_slm(SAMPLE_SIGNALS)
        call_args = mock_ollama.chat.call_args
        messages = call_args.kwargs.get("messages") or call_args[1].get("messages")
        user_msg = messages[1]
        assert user_msg["role"] == "user"
        # The user message should contain signal data, not raw OHLC
        content = user_msg["content"]
        assert "sma_short" in content
        assert "sma_crossover" in content
        assert "zscore" in content
