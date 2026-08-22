# =============================================================================
# Aegis Enclave — Dockerfile
# =============================================================================
# This image is designed to run inside a TEE (dstack / Intel TDX).
#
# CRITICAL: The Ollama model weights are pulled at BUILD time, not container
# start time. This is intentional and required for TEE security:
#
#   - TEE code measurement (MRTD/RTMR hash) is computed over the entire
#     container image contents at launch.
#   - If model weights were pulled at runtime, they would NOT be covered
#     by the measurement, meaning an attacker could substitute a different
#     model without detection.
#   - By baking the weights into the image layer, any change to the model
#     changes the measurement hash, which will cause attestation verification
#     to fail on-chain (AttestationVerifier rejects mismatched measurements).
#
# This is why the image is large (~1.5 GB) — the model weights are part of
# the trusted computing base.
# =============================================================================

FROM python:3.11-slim AS base

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

# ---------------------------------------------------------------------------
# Pull model weights at BUILD time (see comment above for why)
# ---------------------------------------------------------------------------
RUN ollama serve & \
    sleep 5 && \
    ollama pull llama3.2:1b && \
    kill %1 || true

# ---------------------------------------------------------------------------
# Python dependencies
# ---------------------------------------------------------------------------
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------------------------------------------------------------------------
# Application code
# ---------------------------------------------------------------------------
COPY . .

# Copy shared config (mounted or copied at build context level)
# In docker-compose, this is mounted as a volume instead.
# COPY ../shared /shared

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

# Expose the FastAPI port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Start Ollama in the background, then launch the FastAPI server.
# Both must run in the same container because the SLM inference must
# happen inside the same TEE boundary as the signal computation.
CMD bash -c "ollama serve &>/dev/null & sleep 3 && python main.py"
