#!/usr/bin/env bash
# ==============================================================================
# AEGIS ORCHESTRATION PIPELINE
# Runs: Enclave → Attestation → Identity (UserOp) → On-chain rebalance
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

echo "====================================="
echo "AEGIS ORCHESTRATION PIPELINE STARTING"
echo "====================================="

# ---------------------------------------------------------------------------
# 0. Verify required env vars
# ---------------------------------------------------------------------------
REQUIRED_VARS=(
  PIMLICO_API_KEY
  ALCHEMY_API_KEY
  AEGIS_OWNER_PRIVATE_KEY
  SESSION_KEY_PRIVATE_KEY
  AEGIS_VAULT_ADDRESS
  ATTESTATION_VERIFIER_ADDRESS
)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "ERROR: Required environment variable $var is not set."
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 1. Ensure dstack simulator is running
# ---------------------------------------------------------------------------
if pgrep -f "dstack-simulator" > /dev/null 2>&1; then
  echo "=> dstack simulator already running."
else
  echo "=> Starting dstack simulator..."
  if [ -f /tmp/dstack_run2/dstack-simulator ]; then
    nohup /tmp/dstack_run2/dstack-simulator > /tmp/dstack-sim.log 2>&1 &
    sleep 2
    echo "=> dstack simulator started."
  else
    echo "ERROR: dstack-simulator binary not found at /tmp/dstack_run2/dstack-simulator"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. Ensure socat proxy is running (port 8090 → enclave dstack endpoint)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 3. Bring up core infrastructure (Enclave + Railgun)
# ---------------------------------------------------------------------------
echo "=> Bringing up infrastructure (Enclave + Railgun)..."
docker compose up -d enclave railgun-sidecar

# ---------------------------------------------------------------------------
# 4. Wait for enclave to be healthy
# ---------------------------------------------------------------------------
echo "=> Requesting Rebalance Quote from Enclave..."
MAX_RETRIES=30
RETRY_DELAY=2
for i in $(seq 1 $MAX_RETRIES); do
  ENCLAVE_RESPONSE=$(curl -sf -X POST http://localhost:8000/rebalance \
    -H "Content-Type: application/json" \
    --max-time 30 2>/dev/null || true)
  if [ -n "$ENCLAVE_RESPONSE" ]; then
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "ERROR: Enclave did not become healthy after $((MAX_RETRIES * RETRY_DELAY))s"
    docker compose logs enclave
    exit 1
  fi
  sleep "$RETRY_DELAY"
done

echo "Enclave Response: $ENCLAVE_RESPONSE"

# ---------------------------------------------------------------------------
# 5. Parse attestation fields from enclave response
# ---------------------------------------------------------------------------
DECISION_HASH=$(echo "$ENCLAVE_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data['attestation']['report_data_hash'])
" 2>/dev/null)

QUOTE=$(echo "$ENCLAVE_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data['attestation']['quote'])
" 2>/dev/null)

if [ -z "$DECISION_HASH" ] || [ -z "$QUOTE" ]; then
  echo "ERROR: Failed to parse decision_hash or quote from enclave response."
  echo "Response was: $ENCLAVE_RESPONSE"
  exit 1
fi

echo "=> Captured Decision Hash: $DECISION_HASH"
echo "=> Captured TDX Quote: $QUOTE"

# ---------------------------------------------------------------------------
# 6. Submit the transaction via Identity container (ZeroDev + Pimlico)
#    --network host bypasses Docker's virtual DNS, fixing EAI_AGAIN in WSL2
# ---------------------------------------------------------------------------
echo "=> Submitting UserOp via Identity Init Container (Native Linux Node in WSL)..."

set -a
source .env
set +a

cd identity
export PATH="/tmp/node-v20.11.1-linux-x64/bin:$PATH"
export DECISION_HASH="$DECISION_HASH"
export TDX_QUOTE="$QUOTE"
export NODE_OPTIONS="--dns-result-order=ipv4first"
npm run start:submit 2>&1 | tee /tmp/identity_output.txt
cd ..

# ---------------------------------------------------------------------------
# 7. Extract tx hash and report result
# ---------------------------------------------------------------------------
TX_HASH=$(cat /tmp/identity_output.txt | grep "Tx Hash:" | awk '{print $NF}')

if [ -z "$TX_HASH" ]; then
  echo ""
  echo "ERROR: Failed to submit transaction or get Tx Hash."
  exit 1
fi

echo ""
echo "======================================"
echo "AEGIS PIPELINE COMPLETE"
echo "======================================"
echo "Transaction Hash: $TX_HASH"
echo "View on Etherscan: https://sepolia.etherscan.io/tx/$TX_HASH"
