"""
Aegis Enclave — FastAPI Application

The enclave service exposes two endpoints:
  GET  /health     — liveness check
  POST /rebalance  — runs the full pipeline: data_feed → signal → model → attestation

This service is designed to run inside a TEE (dstack/TDX). The Docker image
bakes in the Ollama model weights at build time so they are covered by the
TEE code measurement — see the Dockerfile for details.
"""

import os
import traceback
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from quant.data_feed import fetch_all_assets
from quant.signal import compute_all_signals
from quant.model import query_slm
from attestation import attest_decision

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Aegis Enclave",
    description="Autonomous rebalancing engine running inside a Trusted Execution Environment.",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str
    service: str
    tee_simulator: bool


class AttestationResult(BaseModel):
    quote: str
    report_data_hash: str
    event_log: str


class RebalanceResponse(BaseModel):
    allocation: dict[str, float]
    rationale: str
    confidence: float
    signals: dict[str, Any]
    attestation: AttestationResult


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness check — confirms the enclave service is running."""
    is_simulator = bool(os.environ.get("DSTACK_SIMULATOR_ENDPOINT"))
    return HealthResponse(
        status="ok",
        service="aegis-enclave",
        tee_simulator=is_simulator,
    )


@app.post("/rebalance", response_model=RebalanceResponse)
async def rebalance() -> RebalanceResponse:
    """
    Full rebalance pipeline:

    1. Fetch OHLC data from CoinGecko for whitelisted assets.
    2. Compute deterministic signals (MA crossover, z-score).
    3. Query the local SLM (Ollama llama3.2:1b) for allocation + rationale.
    4. Generate a TEE attestation quote binding the decision.
    5. Return the allocation, rationale, confidence, and attestation proof.
    """
    try:
        # Step 1: Fetch market data
        ohlc_data = fetch_all_assets(days=7)

        # Step 2: Compute deterministic signals
        signals = compute_all_signals(ohlc_data)

        # Step 3: Query SLM for allocation decision
        decision = query_slm(signals)

        # Step 4: Attest the decision via the TEE
        attestation_result = attest_decision(decision)

        return RebalanceResponse(
            allocation=decision["allocations"],
            rationale=decision["rationale"],
            confidence=decision["confidence"],
            signals=signals,
            attestation=AttestationResult(**attestation_result),
        )

    except ValueError as exc:
        # SLM retry exhaustion or validation errors
        raise HTTPException(
            status_code=422,
            detail=f"Rebalance failed — SLM or validation error: {exc}",
        )
    except Exception as exc:
        # Unexpected errors — log the traceback for debugging
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Rebalance failed — internal error: {exc}",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,  # No reload in production/TEE — image is frozen
    )
