"""
Aegis attestation oracle — HTTP service.

Sits between the enclave and the chain. Takes a TDX quote plus the decision it
claims to attest, runs the verification chain in verifier.py, and — only if
every check passes — signs the compact statement that AttestationVerifier.sol
will check on-chain.

Deployment note: this service holds the key that decides which enclave builds
the protocol accepts. It is reachable only from the internal Docker network, it
never accepts a measurement from the caller (it derives one), and it never
returns a signature for input it rejected. If it is compromised, the bound is
that it can attest a measurement no real enclave produced — it still cannot
attest a decision the enclave did not make, because the decision hash comes out
of the quote's report_data.
"""

from __future__ import annotations

import os
import traceback

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from signer import SignerError, load_oracle_account, sign_attestation
from verifier import (
    AttestationRejected,
    measurement_allowlist,
    require_hardware,
    verify_attestation,
)

app = FastAPI(
    title="Aegis Attestation Oracle",
    description="Off-chain TDX quote verification and on-chain attestation signing.",
    version="1.0.0",
)


class AttestRequest(BaseModel):
    quote: str = Field(description="TDX quote, hex encoded")
    decision_hash: str = Field(description="bytes32 the quote should be bound to")
    event_log: str = Field(description="Guest agent event log JSON")
    source: str = Field(default="simulator", description="'simulator' or 'hardware-tdx'")
    verifier_address: str = Field(description="Deployed AttestationVerifier address")
    chain_id: int = Field(description="Chain the proof will be submitted on")


class AttestResponse(BaseModel):
    proof: str
    decisionHash: str
    measurement: str
    expiry: int
    signature: str
    oracleSigner: str
    verifier: str
    chainId: int
    source: str
    hardwareVerified: bool
    checksPerformed: list[str]
    composeHash: str
    bootEvents: dict[str, str]


class HealthResponse(BaseModel):
    status: str
    service: str
    oracleSigner: str
    requireHardware: bool
    allowlistSize: int


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """
    Liveness plus configuration disclosure.

    Reports the signer address and enforcement posture so the pipeline's
    verify_deployment step can confirm the oracle the chain trusts is the oracle
    that is actually running, without having to read the key.
    """
    try:
        signer = load_oracle_account().address
    except SignerError:
        signer = ""

    return HealthResponse(
        status="ok" if signer else "degraded",
        service="aegis-oracle",
        oracleSigner=signer,
        requireHardware=require_hardware(),
        allowlistSize=len(measurement_allowlist()),
    )


@app.post("/attest", response_model=AttestResponse)
def attest(request: AttestRequest) -> AttestResponse:
    """
    Verify a quote and sign an on-chain attestation.

    Returns 422 when the quote fails verification — the stage that failed is
    named in the detail, because "attestation rejected" alone is useless when
    the chain has six distinct checks. Returns 500 only for oracle-side faults.
    """
    try:
        result = verify_attestation(
            quote_hex=request.quote,
            decision_hash_hex=request.decision_hash,
            event_log=request.event_log,
            source=request.source,
        )
    except AttestationRejected as exc:
        raise HTTPException(
            status_code=422,
            detail={"stage": exc.stage, "reason": exc.reason},
        )
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="verification error: " + str(exc))

    try:
        signed = sign_attestation(
            decision_hash=result.decision_hash,
            measurement=result.measurement,
            chain_id=request.chain_id,
            verifier=request.verifier_address,
            # The verifier's own finding, not the enclave's self-report. This is
            # the value the chain will enforce against, so it must come from the
            # step that actually checked the signature chain.
            hardware_verified=result.hardware_verified,
        )
    except SignerError as exc:
        raise HTTPException(status_code=500, detail="signing failed: " + str(exc))

    payload = signed.as_dict()
    return AttestResponse(
        proof=payload["proof"],
        decisionHash=payload["decisionHash"],
        measurement=payload["measurement"],
        expiry=payload["expiry"],
        signature=payload["signature"],
        oracleSigner=payload["oracleSigner"],
        verifier=payload["verifier"],
        chainId=payload["chainId"],
        source=result.source,
        hardwareVerified=result.hardware_verified,
        checksPerformed=result.checks,
        composeHash=result.compose_hash,
        bootEvents=result.boot_events,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("ORACLE_PORT", "8100")),
        reload=False,
    )
