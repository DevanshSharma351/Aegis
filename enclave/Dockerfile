# =============================================================================
# Aegis Enclave
# =============================================================================
# Runs inside a dstack CVM (Intel TDX).
#
# WHY THE MODEL WEIGHTS ARE PULLED AT BUILD TIME:
#
# The TEE measurement covers the container image, and dstack records the
# app-compose document (which names images by digest) into RTMR3 as the
# `compose-hash` event. That hash is half of the enclave measurement this
# protocol binds on-chain — see shared/pylib/aegis_tdx/measurement.py.
#
# If the model were pulled at container start, its weights would sit outside the
# image and therefore outside the measurement. An attacker with control of the
# network or the model registry could serve different weights, the enclave would
# produce attacker-chosen allocations, and the attestation would still verify —
# because nothing about the swapped weights changed the measured image.
#
# Baking them in makes any change to the model change the image digest, change
# the compose hash, change the measurement, and fail verification on-chain.
# That is the whole point, and it is why this image is ~7 GB.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not enclave/:
#     docker build -f enclave/Dockerfile .
# so the image can copy shared/pylib/aegis_tdx. The enclave and the oracle must
# compute measurements with byte-identical code; vendoring a second copy here
# would let them drift, and the drift would surface only as an on-chain revert.
# =============================================================================

FROM python:3.11-slim

# zstd is required by the Ollama installer: it distributes its payload as a zstd
# archive and aborts with a bare error if the tool is missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama.
#
# Downloaded to a file and executed, rather than piped straight into sh. Piping
# means a download interrupted midway feeds a truncated script to the shell,
# which then fails somewhere arbitrary with an exit code that says nothing about
# the real cause. This step pulls ~1.5 GB, so a mid-transfer failure is a
# routine event rather than an exotic one, and `--retry` handles it.
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
        https://ollama.com/install.sh -o /tmp/install-ollama.sh \
    && sh /tmp/install-ollama.sh \
    && rm -f /tmp/install-ollama.sh \
    && ollama --version

ARG AEGIS_SLM_MODEL=llama3.2:1b

# Pull the weights into the image layer. `ollama serve` must be running for
# `ollama pull` to work, so it is started, used, and stopped within this single
# RUN — a background process does not survive between layers.
RUN ollama serve & \
    SERVER_PID=$! && \
    sleep 5 && \
    ollama pull "${AEGIS_SLM_MODEL}" && \
    kill $SERVER_PID || true

WORKDIR /app

COPY enclave/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared measurement/quote code, identical to the oracle's copy.
COPY shared/pylib/aegis_tdx ./aegis_tdx

# Asset whitelist. Baked in rather than mounted: a bind mount would let the
# host change which assets the enclave decides over *without* changing the
# measurement, which would defeat the attestation.
COPY shared/config/assets.json ./shared/config/assets.json

COPY enclave/ ./

ENV AEGIS_SLM_MODEL=${AEGIS_SLM_MODEL} \
    OLLAMA_HOST=http://127.0.0.1:11434 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# start-period is generous because the first request loads model weights from
# disk; a shorter window would mark a healthy enclave as failed during warmup.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Ollama runs inside this same container on purpose: inference must happen
# within the same TEE boundary as the signal computation, so the model cannot be
# reached or replaced across a network hop that the measurement does not cover.
CMD ["/bin/bash", "-c", "ollama serve > /var/log/ollama.log 2>&1 & sleep 4 && exec python main.py"]
