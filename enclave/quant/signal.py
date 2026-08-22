"""
Aegis Enclave — Deterministic Signal Layer

Computes moving averages and z-scores per asset from OHLC data.
This is the "deterministic" layer — its outputs are reproducible given
the same input data, providing a stable foundation for the SLM layer.
"""

from typing import Any

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_moving_averages(
    df: pd.DataFrame,
    short_window: int = 8,
    long_window: int = 21,
) -> pd.DataFrame:
    """
    Add short and long simple moving averages (SMA) to an OHLC DataFrame.

    Uses the 'close' column. Adds columns: sma_short, sma_long.
    """
    df = df.copy()
    df["sma_short"] = df["close"].rolling(window=short_window, min_periods=1).mean()
    df["sma_long"] = df["close"].rolling(window=long_window, min_periods=1).mean()
    return df


def compute_zscore(
    series: pd.Series,
    lookback: int = 21,
) -> pd.Series:
    """
    Compute rolling z-score of a series.

    z = (x - μ) / σ  over a rolling window.
    Returns NaN where σ == 0 (constant series).
    """
    rolling_mean = series.rolling(window=lookback, min_periods=1).mean()
    rolling_std = series.rolling(window=lookback, min_periods=1).std()
    # Avoid division by zero — return 0.0 where std is 0.
    zscore = (series - rolling_mean) / rolling_std.replace(0, np.nan)
    return zscore.fillna(0.0)


def compute_signals(df: pd.DataFrame) -> dict[str, Any]:
    """
    Full signal computation for a single asset.

    Takes an OHLC DataFrame, returns a structured dict summarizing:
    - latest close price
    - short/long SMA values and their crossover state
    - z-score of the close price
    - a simple momentum flag
    """
    if df.empty:
        return {
            "close": None,
            "sma_short": None,
            "sma_long": None,
            "sma_crossover": "insufficient_data",
            "zscore": None,
            "momentum": "neutral",
            "candle_count": 0,
        }

    df = compute_moving_averages(df)
    df["zscore"] = compute_zscore(df["close"])

    latest = df.iloc[-1]

    sma_short = float(latest["sma_short"])
    sma_long = float(latest["sma_long"])
    zscore = float(latest["zscore"])

    # Crossover signal: short > long → bullish, else bearish
    if sma_short > sma_long:
        crossover = "bullish"
    elif sma_short < sma_long:
        crossover = "bearish"
    else:
        crossover = "neutral"

    # Momentum: z-score > 1 → strong up, < -1 → strong down
    if zscore > 1.0:
        momentum = "strong_up"
    elif zscore < -1.0:
        momentum = "strong_down"
    elif zscore > 0.3:
        momentum = "mild_up"
    elif zscore < -0.3:
        momentum = "mild_down"
    else:
        momentum = "neutral"

    return {
        "close": round(float(latest["close"]), 6),
        "sma_short": round(sma_short, 6),
        "sma_long": round(sma_long, 6),
        "sma_crossover": crossover,
        "zscore": round(zscore, 4),
        "momentum": momentum,
        "candle_count": len(df),
    }


def compute_all_signals(
    ohlc_data: dict[str, pd.DataFrame],
) -> dict[str, dict[str, Any]]:
    """
    Compute signals for all assets.

    Args:
        ohlc_data: dict mapping symbol → OHLC DataFrame (from data_feed.fetch_all_assets).

    Returns:
        dict mapping symbol → signal summary dict.
    """
    return {symbol: compute_signals(df) for symbol, df in ohlc_data.items()}
