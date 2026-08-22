#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.env"

if [ -z "$ALCHEMY_API_KEY" ]; then
    echo "ERROR: ALCHEMY_API_KEY is not set in .env"
    exit 1
fi

RPC_URL="https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY"
WETH_ADDRESS="0xfff9976782d46CC05630D1f6eBAb18b2324d6B14"

echo "====================================="
echo "AEGIS: FUND VAULT WITH WETH (Sepolia)"
echo "====================================="
echo "Vault Address: $AEGIS_VAULT_ADDRESS"

if [ -z "$AEGIS_VAULT_ADDRESS" ]; then
    echo "ERROR: AEGIS_VAULT_ADDRESS is empty. Deploy contracts first."
    exit 1
fi

echo "=> Wrapping 0.02 Sepolia ETH to WETH..."
# Call deposit() on WETH9 contract with value
~/.foundry/bin/cast send $WETH_ADDRESS "deposit()" --value 0.02ether --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY

echo "=> Transferring 0.02 WETH to Vault..."
~/.foundry/bin/cast send $WETH_ADDRESS "transfer(address,uint256)(bool)" $AEGIS_VAULT_ADDRESS 20000000000000000 --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY

echo "====================================="
echo "Vault Funded Successfully!"
echo "====================================="
