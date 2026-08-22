"""
Aegis Enclave -- market data.

Pulls OHLC candles from CoinGecko for the assets in shared/config/assets.json.

FAILURE POLICY: this module raises rather than degrading. The previous version
caught request errors per asset and substituted an empty DataFrame, which made
the signal layer emit "insufficient_data" and left the model allocating capital
from nothing while the pipeline still reported success. A rebalance built on
absent data is worse than no rebalance, and the enclave attests whatever it
produces -- so a bad decision would carry a perfectly valid proof.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pandas as pd
import requests

_COINGECKO_BASE = "https://api.coingecko.com/api/v3"

# CoinGecko's free tier allows roughly 30 requests/minute. With a two-asset
# whitelist the delay is a courtesy rather than a necessity, so it is tunable
# and defaults low enough not to dominate the enclave's response time.
_REQUEST_DELAY_S = float(os.environ.get("COINGECKO_REQUEST_DELAY_S", "1.5"))
_REQUEST_TIMEOUT_S = float(os.environ.get("COINGECKO_TIMEOUT_S", "20"))
_MAX_ATTEMPTS = int(os.environ.get("COINGECKO_MAX_ATTEMPTS", "3"))

# Below this many candles the rolling windows in signal.py are mostly seeded by
# min_periods rather than real history, and the resulting z-score is noise.
MIN_CANDLES = int(os.environ.get("COINGECKO_MIN_CANDLES", "8"))

_OHLC_COLUMNS = ["timestamp", "open", "high", "low", "close"]


class DataFeedError(RuntimeError):
    """Raised when market data cannot be obtained well enough to decide on."""


def _assets_path() -> Path:
    """
    Locate shared/config/assets.json.

    In the container the shared directory is mounted at /app/shared; running the
    enclave directly from a checkout it sits two levels up. Checking the
    container path first keeps both working without an environment variable.
    """
    override = os.environ.get("AEGIS_ASSETS_PATH")
    if override:
        return Path(override)

    container_path = Path("/app/shared/config/assets.json")
    if container_path.exists():
        return container_path

    return Path(__file__).resolve().parent.parent.parent / "shared" / "config" / "assets.json"


def load_whitelisted_assets() -> list[dict[str, Any]]:
    """Load the whitelisted asset list from shared/config/assets.json."""
    path = _assets_path()
    if not path.exists():
        raise DataFeedError(
            "asset whitelist not found at " + str(path) + ". The enclave cannot "
            "decide over an unknown asset set."
        )
    with open(path, "r", encoding="utf-8") as handle:
        assets = json.load(handle)["assets"]
    if not assets:
        raise DataFeedError("asset whitelist is empty: " + str(path))
    return assets


def fetch_ohlc(coingecko_id: str, vs_currency: str = "usd", days: int = 7) -> pd.DataFrame:
    """
    Fetch OHLC candles for one asset.

    Retries on transient failures (timeouts, 5xx, and 429 rate limits) with
    linear backoff, then raises. Retrying matters here because a single
    CoinGecko hiccup should not abort a rebalance, but silently continuing
    without the data should never happen.

    Returns:
        DataFrame with columns [timestamp, open, high, low, close]; timestamps
        are UTC-aware.
    """
    url = _COINGECKO_BASE + "/coins/" + coingecko_id + "/ohlc"
    params: dict[str, Any] = {"vs_currency": vs_currency, "days": str(days)}

    api_key = os.environ.get("COINGECKO_API_KEY", "").strip()
    if api_key:
        params["x_cg_demo_api_key"] = api_key

    last_error: Exception | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = requests.get(url, params=params, timeout=_REQUEST_TIMEOUT_S)

            if response.status_code == 429 or response.status_code >= 500:
                raise requests.RequestException(
                    "CoinGecko returned HTTP " + str(response.status_code)
                )
            response.raise_for_status()

            raw = response.json()
            if not isinstance(raw, list):
                raise DataFeedError(
                    "CoinGecko returned an unexpected payload for " + coingecko_id
                    + ": " + repr(raw)[:200]
                )

            frame = pd.DataFrame(raw, columns=_OHLC_COLUMNS)
            frame["timestamp"] = pd.to_datetime(frame["timestamp"], unit="ms", utc=True)
            return frame

        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS:
                backoff = _REQUEST_DELAY_S * attempt
                print(
                    "[data_feed] attempt " + str(attempt) + "/" + str(_MAX_ATTEMPTS)
                    + " for " + coingecko_id + " failed (" + str(exc) + "); retrying in "
                    + str(backoff) + "s"
                )
                time.sleep(backoff)

    raise DataFeedError(
        "failed to fetch OHLC for " + coingecko_id + " after " + str(_MAX_ATTEMPTS)
        + " attempts: " + str(last_error)
    )


def fetch_all_assets(days: int = 7, vs_currency: str = "usd") -> dict[str, pd.DataFrame]:
    """
    Fetch OHLC data for every whitelisted asset.

    Raises DataFeedError if any asset fails, or if any asset returns fewer than
    MIN_CANDLES rows. Partial data is not acceptable input to an allocation
    decision that will be signed and executed.
    """
    assets = load_whitelisted_assets()
    result: dict[str, pd.DataFrame] = {}

    for index, asset in enumerate(assets):
        symbol = asset["symbol"]
        frame = fetch_ohlc(asset["coingeckoId"], vs_currency=vs_currency, days=days)

        if len(frame) < MIN_CANDLES:
            raise DataFeedError(
                symbol + " returned only " + str(len(frame)) + " candles, below the "
                + str(MIN_CANDLES) + " needed for a meaningful signal. Refusing to "
                "decide on insufficient history."
            )

        result[symbol] = frame

        if index < len(assets) - 1:
            time.sleep(_REQUEST_DELAY_S)

    return result
