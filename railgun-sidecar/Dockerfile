# =============================================================================
# Aegis Railgun sidecar
# =============================================================================
# Build context is the REPOSITORY ROOT:
#     docker build -f railgun-sidecar/Dockerfile .
#
# Holds RAILGUN_WALLET_MNEMONIC, which controls the shielded balance. Placed on
# an internal-only Docker network with no published ports; see the isolation
# note in docker-compose.yml.
#
# Build tooling (python3/make/g++) is required because leveldown is a native
# module. It is installed and removed in the same layer so the compiler does not
# ship in the runtime image.
# =============================================================================

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY railgun-sidecar/package.json railgun-sidecar/package-lock.json* ./
RUN npm config set fetch-retries 5     && npm config set fetch-retry-mintimeout 20000     && npm config set fetch-retry-maxtimeout 180000     && npm config set fetch-timeout 600000

RUN npm install --omit=dev --no-audit --no-fund && npm install tsx typescript

COPY railgun-sidecar/tsconfig.json ./
COPY railgun-sidecar/src ./src
COPY shared ./shared

# Engine state (merkletree + wallet) and Groth16 artifacts live here. Mounted as
# a named volume in compose: a cold merkletree scan takes ~45s and artifact
# download is tens of megabytes, so losing this on every restart is expensive.
RUN mkdir -p /data/railgun
ENV NODE_ENV=production \
    AEGIS_REPO_ROOT=/app \
    RAILGUN_ENGINE_DB_PATH=/data/railgun \
    PORT=8080

EXPOSE 8080

# start-period covers the merkletree scan; the service reports 503 from /health
# until the engine is actually ready rather than claiming health early.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
