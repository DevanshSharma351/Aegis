#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.env"

echo "====================================="
echo "AEGIS SANITY CHECKS"
echo "====================================="

if [ -z "$AEGIS_VAULT_ADDRESS" ] || [ -z "$ATTESTATION_VERIFIER_ADDRESS" ]; then
    echo "ERROR: Contract addresses not set in .env"
    exit 1
fi

RPC_URL="https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY"
# Use localhost:8545 for anvil tests if ALCHEMY_API_KEY is not set or we're in CI
if [ -z "$ALCHEMY_API_KEY" ]; then
    RPC_URL="http://localhost:8545"
fi

echo "=> Checking Vault Session Key..."
# Vault has a public sessionKey variable. Let's read it via cast.
VAULT_SESSION_KEY=$(~/.foundry/bin/cast call $AEGIS_VAULT_ADDRESS "sessionKey()(address)" --rpc-url $RPC_URL)
# Get the address from our local private key
LOCAL_SESSION_KEY=$(~/.foundry/bin/cast wallet address --private-key $SESSION_KEY_PRIVATE_KEY)

if [ "$VAULT_SESSION_KEY" = "$LOCAL_SESSION_KEY" ]; then
    echo "[PASS] Vault Session Key matches local Identity key."
else
    echo "[FAIL] Vault Session Key ($VAULT_SESSION_KEY) does NOT match local Identity key ($LOCAL_SESSION_KEY)."
    exit 1
fi

echo "=> Checking Verifier Measurement..."
VERIFIER_MEASUREMENT=$(~/.foundry/bin/cast call $ATTESTATION_VERIFIER_ADDRESS "expectedMeasurement()(bytes32)" --rpc-url $RPC_URL)
# Get expected build hash from enclave build or mock
MOCK_MEASUREMENT=$(~/.foundry/bin/cast keccak "MOCK_ENCLAVE_MEASUREMENT")

if [ "$VERIFIER_MEASUREMENT" = "$MOCK_MEASUREMENT" ]; then
    echo "[PASS] Verifier expectedMeasurement matches enclave mock build hash."
else
    echo "[FAIL] Verifier expectedMeasurement ($VERIFIER_MEASUREMENT) does NOT match enclave ($MOCK_MEASUREMENT)."
    exit 1
fi

echo "=> Checking Railgun Sidecar Isolation..."
# We expect this to fail or connection refused, as it's not exposed to host
if curl --connect-timeout 2 -s http://localhost:8080 > /dev/null; then
    echo "[FAIL] Railgun Sidecar is reachable from the host! It should be isolated to internal_net."
    exit 1
else
    echo "[PASS] Railgun Sidecar is NOT reachable from the host."
fi

echo "====================================="
echo "ALL SANITY CHECKS PASSED!"
echo "====================================="
