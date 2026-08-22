"""
Tests for the deterministic signal layer (quant/signal.py).

These tests verify that:
- Moving averages are computed correctly
- Z-scores are computed correctly
- Signal summaries have the expected structure
- Edge cases (empty data, constant prices) are handled
"""

import numpy as np
import pandas as pd
import pytest

from quant.signal import (
    compute_moving_averages,
    compute_zscore,
    compute_signals,
    compute_all_signals,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_ohlc() -> pd.DataFrame:
    """Create a sample OHLC DataFrame with 30 candles."""
    np.random.seed(42)
    n = 30
    base_price = 2000.0
    # Simulate a gentle uptrend with noise
    closes = base_price + np.cumsum(np.random.randn(n) * 20)
    return pd.DataFrame({
        "timestamp": pd.date_range("2024-01-01", periods=n, freq="4h", tz="UTC"),
        "open": closes - np.random.rand(n) * 10,
        "high": closes + np.random.rand(n) * 15,
        "low": closes - np.random.rand(n) * 15,
        "close": closes,
    })


@pytest.fixture
def empty_ohlc() -> pd.DataFrame:
    """Create an empty OHLC DataFrame."""
    return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close"])


@pytest.fixture
def constant_ohlc() -> pd.DataFrame:
    """Create an OHLC DataFrame where all prices are identical (edge case)."""
    n = 25
    price = 1800.0
    return pd.DataFrame({
        "timestamp": pd.date_range("2024-01-01", periods=n, freq="4h", tz="UTC"),
        "open": [price] * n,
        "high": [price] * n,
        "low": [price] * n,
        "close": [price] * n,
    })


# ---------------------------------------------------------------------------
# Moving average tests
# ---------------------------------------------------------------------------

class TestMovingAverages:
    def test_adds_sma_columns(self, sample_ohlc: pd.DataFrame):
        result = compute_moving_averages(sample_ohlc)
        assert "sma_short" in result.columns
        assert "sma_long" in result.columns

    def test_sma_length_matches_input(self, sample_ohlc: pd.DataFrame):
        result = compute_moving_averages(sample_ohlc)
        assert len(result) == len(sample_ohlc)

    def test_sma_values_are_numeric(self, sample_ohlc: pd.DataFrame):
        result = compute_moving_averages(sample_ohlc)
        assert result["sma_short"].dtype in [np.float64, np.float32]
        assert result["sma_long"].dtype in [np.float64, np.float32]

    def test_sma_no_nans(self, sample_ohlc: pd.DataFrame):
        """min_periods=1 means no NaN even at the start."""
        result = compute_moving_averages(sample_ohlc)
        assert not result["sma_short"].isna().any()
        assert not result["sma_long"].isna().any()

    def test_does_not_mutate_input(self, sample_ohlc: pd.DataFrame):
        original_cols = set(sample_ohlc.columns)
        compute_moving_averages(sample_ohlc)
        assert set(sample_ohlc.columns) == original_cols


# ---------------------------------------------------------------------------
# Z-score tests
# ---------------------------------------------------------------------------

class TestZScore:
    def test_zscore_shape(self, sample_ohlc: pd.DataFrame):
        zs = compute_zscore(sample_ohlc["close"])
        assert len(zs) == len(sample_ohlc)

    def test_zscore_no_nans(self, sample_ohlc: pd.DataFrame):
        zs = compute_zscore(sample_ohlc["close"])
        assert not zs.isna().any()

    def test_zscore_constant_series(self, constant_ohlc: pd.DataFrame):
        """Constant series → std=0 → z-score should be 0, not NaN/inf."""
        zs = compute_zscore(constant_ohlc["close"])
        assert not zs.isna().any()
        assert (zs == 0.0).all()


# ---------------------------------------------------------------------------
# Signal computation tests
# ---------------------------------------------------------------------------

class TestComputeSignals:
    def test_signal_keys(self, sample_ohlc: pd.DataFrame):
        result = compute_signals(sample_ohlc)
        expected_keys = {
            "close", "sma_short", "sma_long",
            "sma_crossover", "zscore", "momentum", "candle_count",
        }
        assert set(result.keys()) == expected_keys

    def test_signal_types(self, sample_ohlc: pd.DataFrame):
        result = compute_signals(sample_ohlc)
        assert isinstance(result["close"], float)
        assert isinstance(result["sma_short"], float)
        assert isinstance(result["sma_long"], float)
        assert isinstance(result["zscore"], float)
        assert isinstance(result["candle_count"], int)
        assert result["sma_crossover"] in ("bullish", "bearish", "neutral")
        assert result["momentum"] in (
            "strong_up", "strong_down", "mild_up", "mild_down", "neutral"
        )

    def test_empty_data_returns_defaults(self, empty_ohlc: pd.DataFrame):
        result = compute_signals(empty_ohlc)
        assert result["close"] is None
        assert result["sma_crossover"] == "insufficient_data"
        assert result["momentum"] == "neutral"
        assert result["candle_count"] == 0

    def test_candle_count_matches(self, sample_ohlc: pd.DataFrame):
        result = compute_signals(sample_ohlc)
        assert result["candle_count"] == len(sample_ohlc)


class TestComputeAllSignals:
    def test_all_signals_returns_per_asset(self, sample_ohlc: pd.DataFrame):
        data = {"WETH": sample_ohlc, "USDC": sample_ohlc.copy()}
        result = compute_all_signals(data)
        assert "WETH" in result
        assert "USDC" in result
        assert set(result["WETH"].keys()) == {
            "close", "sma_short", "sma_long",
            "sma_crossover", "zscore", "momentum", "candle_count",
        }
