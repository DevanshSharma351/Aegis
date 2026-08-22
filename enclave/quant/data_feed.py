"""
Aegis Enclave — Data Feed Module

Pulls OHLC data from the CoinGecko free API for assets defined in
shared/config/assets.json. Returns structured DataFrames for downstream
signal computation.
"""

import json
import os
import time
from pathlib import Path
from typing import Any

import pandas as pd
import requests

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

_docker_path = Path("/app/shared/config/assets.json")
if _docker_path.exists():
    _ASSETS_PATH = _docker_path
else:
    _SHARED_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "shared" / "config"
    _ASSETS_PATH = _SHARED_CONFIG_DIR / "assets.json"


def load_whitelisted_assets() -> list[dict[str, Any]]:
    """Load the whitelisted asset list from shared/config/assets.json."""
    with open(_ASSETS_PATH, "r") as f:
        data = json.load(f)
    return data["assets"]


# ---------------------------------------------------------------------------
# CoinGecko OHLC fetcher
# ---------------------------------------------------------------------------

_COINGECKO_BASE = "https://api.coingecko.com/api/v3"
# Rate-limit: free tier allows ~30 req/min; we add a polite delay.
_REQUEST_DELAY_S = 2.5


def fetch_ohlc(
    coingecko_id: str,
    vs_currency: str = "usd",
    days: int = 7,
) -> pd.DataFrame:
    """
    Fetch OHLC candle data for a single asset from CoinGecko.

    Returns a DataFrame with columns: [timestamp, open, high, low, close].
    Timestamps are UTC-aware datetime objects.

    Args:
        coingecko_id: CoinGecko coin identifier (e.g. "weth", "usd-coin").
        vs_currency: Quote currency (default "usd").
        days: Lookback window in days (1, 7, 14, 30, 90, 180, 365, or "max").
    """
    url = f"{_COINGECKO_BASE}/coins/{coingecko_id}/ohlc"
    params: dict[str, Any] = {
        "vs_currency": vs_currency,
        "days": str(days),
    }

    # Optionally pass a demo API key if one is configured.
    api_key = os.environ.get("COINGECKO_API_KEY")
    if api_key:
        params["x_cg_demo_api_key"] = api_key

    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()

    raw: list[list[float]] = resp.json()
    # CoinGecko returns [[timestamp_ms, open, high, low, close], ...]
    df = pd.DataFrame(raw, columns=["timestamp", "open", "high", "low", "close"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    return df


def fetch_all_assets(
    days: int = 7,
    vs_currency: str = "usd",
) -> dict[str, pd.DataFrame]:
    """
    Fetch OHLC data for every whitelisted asset.

    Returns a dict mapping asset symbol → OHLC DataFrame.
    """
    assets = load_whitelisted_assets()
    result: dict[str, pd.DataFrame] = {}

    for asset in assets:
        symbol = asset["symbol"]
        cg_id = asset["coingeckoId"]
        try:
            df = fetch_ohlc(cg_id, vs_currency=vs_currency, days=days)
            result[symbol] = df
        except requests.RequestException as exc:
            # Log but don't crash the whole pipeline for one asset failure.
            print(f"[data_feed] WARNING: failed to fetch {symbol} ({cg_id}): {exc}")
            result[symbol] = pd.DataFrame(
                columns=["timestamp", "open", "high", "low", "close"]
            )
        # Polite rate-limit pause between requests.
        time.sleep(_REQUEST_DELAY_S)

    return result
