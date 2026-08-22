"""
Aegis Enclave — FastAPI application.

Endpoints:
  GET  /health       liveness plus attestation-source disclosure
  GET  /measurement  this enclave's code measurement and TCB registers
  POST /rebalance    data → signals → SLM → TDX-attested decision

Runs inside a dstack CVM (Intel TDX). The image bakes the Ollama model weights
in at build time so they fall under the TEE measurement — see the Dockerfile.

This service does NOT submit transactions. It produces an attested decision and
stops. Signing and submission belong to the identity service, which holds the
session key; keeping them apart means a compromised enclave still cannot move
anything on-chain without also defeating the session-key policy.
"""

from __future__ import annotations

import traceback
from typing import Any

import os

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from attestation import attestation_source, attest_decision, get_enclave_identity
from quant.data_feed import DataFeedError, fetch_all_assets
from quant.model import SLMError, query_slm
from quant.signal import compute_all_signals

app = FastAPI(
    title="Aegis Enclave",
    description="Autonomous rebalancing engine running inside a Trusted Execution Environment.",
    version="1.0.0",
)

# The enclave is the only service on both the internal and egress networks, so
# it is the single controlled entry point a browser can use to reach the
# Railgun sidecar. The sidecar itself stays unreachable from the host: it holds
# the wallet mnemonic, and exposing it directly to a browser would undo the
# isolation the whole topology is built around.
#
# Origins are allow-listed rather than "*" because these endpoints move funds.
_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "AEGIS_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Reachable only across the internal Docker network.
RAILGUN_SIDECAR_URL = os.environ.get("RAILGUN_SIDECAR_URL", "http://railgun-sidecar:8080")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str
    service: str
    attestation_source: str = Field(
        description="'simulator' or 'hardware-tdx'. Never inferred by the caller."
    )
    guest_agent_reachable: bool


class MeasurementResponse(BaseModel):
    measurement: str = Field(description="bytes32 for AttestationVerifier.expectedMeasurement")
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


class AttestationResult(BaseModel):
    quote: str
    decision_hash: str
    measurement: str
    compose_hash: str
    event_log: str
    source: str
    generated_at: int


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
def health() -> HealthResponse:
    """
    Liveness check.

    Probes the dstack guest agent rather than only reporting that the process is
    up: an enclave that cannot reach its guest agent can serve /health all day
    while being unable to attest anything, which is precisely the failure this
    endpoint exists to catch.
    """
    reachable = True
    try:
        get_enclave_identity()
    except Exception:
        reachable = False

    return HealthResponse(
        status="ok" if reachable else "degraded",
        service="aegis-enclave",
        attestation_source=attestation_source(),
        guest_agent_reachable=reachable,
    )


@app.get("/measurement", response_model=MeasurementResponse)
def measurement() -> MeasurementResponse:
    """
    Report this enclave's code identity.

    Consumed by scripts/deploy_sepolia.sh (to set the on-chain constant) and by
    scripts/verify_deployment.sh (to detect drift after a rebuild).
    """
    try:
        return MeasurementResponse(**get_enclave_identity().as_dict())
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=503,
            detail="Cannot read enclave measurement from the dstack guest agent: " + str(exc),
        )


@app.post("/rebalance", response_model=RebalanceResponse)
def rebalance() -> RebalanceResponse:
    """
    Produce one attested rebalance decision.

    1. Fetch OHLC data for the whitelisted assets.
    2. Compute deterministic signals (SMA crossover, rolling z-score).
    3. Ask the local SLM for an allocation over those signals.
    4. Bind the decision hash into a TDX quote.

    Every failure mode returns a distinct status code, because the orchestrator
    needs to tell "market data unavailable" (retry later) apart from "the guest
    agent is broken" (the enclave is misconfigured) apart from "the model will
    not produce valid output" (a model or prompt problem).
    """
    try:
        ohlc = fetch_all_assets(days=7)
    except DataFeedError as exc:
        raise HTTPException(status_code=503, detail="Market data unavailable: " + str(exc))

    try:
        signals = compute_all_signals(ohlc)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Signal computation failed: " + str(exc))

    try:
        decision = query_slm(signals)
    except SLMError as exc:
        raise HTTPException(status_code=422, detail="SLM produced no valid allocation: " + str(exc))

    try:
        attestation = attest_decision(decision)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=503, detail="Attestation failed: " + str(exc))

    return RebalanceResponse(
        allocation=decision["allocations"],
        rationale=decision["rationale"],
        confidence=decision["confidence"],
        signals=signals,
        attestation=AttestationResult(**attestation),
    )


# ---------------------------------------------------------------------------
# Railgun private execution
# ---------------------------------------------------------------------------
# These proxy to the sidecar rather than reimplementing anything. The enclave
# adds the network boundary and nothing else: it does not hold the mnemonic, it
# does not build the recipe, and it does not decide whether POI was satisfied.
# It forwards the sidecar's own answer verbatim so a browser cannot be shown a
# status the sidecar did not actually report.


class PrivateSwapRequest(BaseModel):
    sellToken: str = Field(default="WETH", description="Whitelisted symbol or address")
    buyToken: str = Field(default="USDC", description="Whitelisted symbol or address")
    sellAmount: str = Field(description="Base-unit integer, as a string")
    slippageBps: int = Field(default=150, ge=1, le=1000)


@app.get("/railgun/status")
async def railgun_status() -> dict[str, Any]:
    """
    Report the sidecar's real status, including POI mode and submission route.

    Passed through unmodified. The UI needs to distinguish a genuine POI path
    from an unconfigured one, and a private submission from a public one; the
    only trustworthy source for that is the component that performed the work.
    """
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(RAILGUN_SIDECAR_URL + "/health")
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Railgun sidecar unreachable: " + str(exc))


@app.get("/railgun/balances")
async def railgun_balances() -> dict[str, Any]:
    """Shielded balances, split into total and POI-spendable."""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.get(RAILGUN_SIDECAR_URL + "/balances")
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text[:400])
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Railgun sidecar unreachable: " + str(exc))


@app.post("/railgun/private-swap")
async def private_swap(request: PrivateSwapRequest) -> dict[str, Any]:
    """
    Execute one atomic unshield -> Uniswap V3 swap -> reshield.

    Long timeout by design: the sidecar generates a real Groth16 proof, which
    dominates the request. Nothing is returned until the transaction is mined,
    so a caller never sees a pending state presented as a completed one.
    """
    try:
        async with httpx.AsyncClient(timeout=900) as client:
            response = await client.post(
                RAILGUN_SIDECAR_URL + "/unshield-swap-reshield",
                json=request.model_dump(),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Railgun sidecar unreachable: " + str(exc))

    body = response.json()
    if response.status_code != 200 or not body.get("success"):
        # Forward the sidecar's status so the caller can distinguish a missing
        # capability (501) from a genuine execution failure (500).
        raise HTTPException(
            status_code=response.status_code if response.status_code != 200 else 500,
            detail=body.get("error", "private swap failed"),
        )

    return body


if __name__ == "__main__":
    import uvicorn

    # No reload: the image is frozen and its contents are part of the TEE
    # measurement. A hot-reloading enclave would attest code it is no longer
    # running.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
