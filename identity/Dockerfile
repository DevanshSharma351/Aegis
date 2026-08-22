# =============================================================================
# Aegis identity service (ERC-4337 smart account + session key)
# =============================================================================
# Build context is the REPOSITORY ROOT so shared/config and shared/abi come in:
#     docker build -f identity/Dockerfile .
#
# Holds SESSION_KEY_PRIVATE_KEY. Reachable only from the internal network.
# =============================================================================

FROM node:20-bookworm-slim

WORKDIR /app

COPY identity/package.json identity/package-lock.json* ./
RUN npm config set fetch-retries 5     && npm config set fetch-retry-mintimeout 20000     && npm config set fetch-retry-maxtimeout 180000     && npm config set fetch-timeout 600000

RUN npm install --omit=dev --no-audit --no-fund && npm install tsx typescript

COPY identity/tsconfig.json ./
COPY identity/src ./src

# shared/ must sit where config.ts finds it: it walks up from __dirname looking
# for shared/config, so placing it at /app/shared makes /app the repo root.
COPY shared ./shared

ENV NODE_ENV=production \
    AEGIS_REPO_ROOT=/app \
    IDENTITY_PORT=8200

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8200/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
