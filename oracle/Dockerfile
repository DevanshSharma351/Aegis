# =============================================================================
# Aegis attestation oracle
# =============================================================================
# Verifies TDX quotes off-chain and signs the compact statement that
# AttestationVerifier.sol checks on-chain.
#
# Build context is the REPOSITORY ROOT, not this directory, so the image can
# copy shared/pylib/aegis_tdx. The oracle and the enclave must derive
# measurements through byte-identical code; vendoring a second copy into this
# directory would let the two drift, and the drift would only ever surface as
# an on-chain revert.
#
# Runs as a non-root user: this process holds the oracle signing key.
# =============================================================================

FROM python:3.11-slim

WORKDIR /app

COPY oracle/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/pylib/aegis_tdx ./aegis_tdx
COPY oracle/ ./

RUN useradd --create-home --uid 10001 aegis && chown -R aegis:aegis /app
USER aegis

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=4).status==200 else 1)"

CMD ["python", "main.py"]
