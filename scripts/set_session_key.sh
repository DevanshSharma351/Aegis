#!/bin/bash
# Sets the session key on the deployed AegisVault contract.
# The session key is the Kernel Smart Account address derived from AEGIS_OWNER_PRIVATE_KEY + Pimlico infra.
# This must be called ONCE by the deployer before the pipeline can submit transactions.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.env"

if [ -z "$AEGIS_VAULT_ADDRESS" ] || [ -z "$DEPLOYER_PRIVATE_KEY" ] || [ -z "$ALCHEMY_API_KEY" ]; then
    echo "ERROR: Missing required env vars: AEGIS_VAULT_ADDRESS, DEPLOYER_PRIVATE_KEY, ALCHEMY_API_KEY"
    exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: ./set_session_key.sh <KERNEL_SMART_ACCOUNT_ADDRESS>"
    echo ""
    echo "To find the Kernel Smart Account address, run:"
    echo "  docker compose run --rm -e AEGIS_OWNER_PRIVATE_KEY=\$AEGIS_OWNER_PRIVATE_KEY -e PIMLICO_API_KEY=\$PIMLICO_API_KEY -e ALCHEMY_API_KEY=\$ALCHEMY_API_KEY identity node -e \"require('./src/createAccount').getAccount().then(r => { console.log('SMART_ACCOUNT:', r.account.address); process.exit(0); })\""
    exit 1
fi

SESSION_KEY_ADDRESS="$1"
RPC_URL="https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}"

echo "=> Setting session key on AegisVault..."
echo "   Vault:       $AEGIS_VAULT_ADDRESS"
echo "   Session Key: $SESSION_KEY_ADDRESS"
echo "   RPC:         $RPC_URL"

# cast send with sig string in single quotes to avoid shell expansion issues
~/.foundry/bin/cast send \
    "$AEGIS_VAULT_ADDRESS" \
    'setSessionKey(address)' \
    "$SESSION_KEY_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY"

echo "=> Session key set successfully!"
echo "=> The pipeline can now submit rebalance transactions from: $SESSION_KEY_ADDRESS"
