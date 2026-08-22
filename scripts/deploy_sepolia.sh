#!/usr/bin/env bash
# =============================================================================
# Deploy AttestationVerifier + AegisVault to Sepolia.
# =============================================================================
# The enclave measurement is read from the RUNNING enclave rather than passed in
# or hard-coded. That is deliberate: AttestationVerifier.expectedMeasurement is
# the value that decides which enclave build the protocol accepts, and deploying
# against a measurement nobody has observed is exactly the failure this contract
# exists to prevent.
#
# Order matters. The enclave must be built and running first, because its image
# determines the measurement that gets burned into the constructor.
#
#   scripts/deploy_sepolia.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; source .env; set +a; }

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }
die()  { printf '\n%s[FAIL]%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_common.sh"
PY=$(aegis_find_python) || exit 1

: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in .env}"
: "${AEGIS_ORACLE_PRIVATE_KEY:?set AEGIS_ORACLE_PRIVATE_KEY in .env}"

RPC_URL="${AEGIS_RPC_URL:-}"
if [ -z "$RPC_URL" ]; then
  [ -n "${ALCHEMY_API_KEY:-}" ] \
    && RPC_URL="https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}" \
    || RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
fi

# -----------------------------------------------------------------------------
step "1. Enclave measurement"
# -----------------------------------------------------------------------------
docker compose up -d --wait --wait-timeout 600 dstack-simulator enclave \
  || die "could not start the enclave; its measurement is required to deploy"

MEASUREMENT_JSON=$(curl -sf -m 60 http://localhost:8000/measurement) \
  || die "enclave /measurement failed. Logs: docker compose logs enclave"

MEASUREMENT=$(echo "$MEASUREMENT_JSON" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['measurement'])")
SOURCE=$(echo "$MEASUREMENT_JSON" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['source'])")
COMPOSE_HASH=$(echo "$MEASUREMENT_JSON" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['compose_hash'])")

[ "$MEASUREMENT" != "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
  || die "enclave reported a zero measurement"

echo "    measurement  $MEASUREMENT"
echo "    compose hash $COMPOSE_HASH"
echo "    source       $SOURCE"

# -----------------------------------------------------------------------------
step "2. Oracle signing address"
# -----------------------------------------------------------------------------
ORACLE_ADDRESS=$("$PY" - <<'PYEOF'
import os
from eth_account import Account

key = os.environ["AEGIS_ORACLE_PRIVATE_KEY"].strip()
print(Account.from_key(key if key.startswith("0x") else "0x" + key).address)
PYEOF
) || die "could not derive the oracle address (is eth-account installed? pip install eth-account)"

echo "    oracle signer $ORACLE_ADDRESS"

# -----------------------------------------------------------------------------
step "3. Deploying"
# -----------------------------------------------------------------------------
cd contracts

forge build || die "forge build failed"
forge test || die "contract tests failed — refusing to deploy"

AEGIS_ORACLE_ADDRESS="$ORACLE_ADDRESS" \
AEGIS_ENCLAVE_MEASUREMENT="$MEASUREMENT" \
AEGIS_ATTESTATION_SOURCE="$SOURCE" \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url "$RPC_URL" \
  --broadcast \
  -vvv || die "deployment failed"

cd "$ROOT_DIR"

# -----------------------------------------------------------------------------
step "4. Syncing ABIs"
# -----------------------------------------------------------------------------
"$PY" scripts/sync_abi.py || die "ABI sync failed"

# -----------------------------------------------------------------------------
step "Deployed"
# -----------------------------------------------------------------------------
"$PY" -c "
import json
d = json.load(open('shared/config/deployed.json', encoding='utf-8-sig'))
for k in ('AegisVault','AttestationVerifier','oracleSigner','expectedMeasurement','chainId','deployedAtBlock'):
    if k in d:
        print(f'  {k:22s} {d[k]}')
"

cat <<'NEXT'

  Next, bind the executing account to the vault (one-shot, irreversible):

    scripts/bootstrap.sh

NEXT
