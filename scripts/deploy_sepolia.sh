#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env
set -a
source "$SCRIPT_DIR/../.env"
set +a

if [ -z "$ALCHEMY_API_KEY" ]; then
    echo "ERROR: ALCHEMY_API_KEY is not set in .env"
    exit 1
fi

if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
    echo "ERROR: DEPLOYER_PRIVATE_KEY is not set in .env"
    exit 1
fi

echo "====================================="
echo "AEGIS: LIVE SEPOLIA DEPLOYMENT"
echo "====================================="
echo "RPC URL: https://eth-sepolia.g.alchemy.com/v2/..."

cd "$SCRIPT_DIR/../contracts"

# Execute Forge Script against live Sepolia RPC
~/.foundry/bin/forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY \
  --broadcast \
  --verify \
  --private-key $DEPLOYER_PRIVATE_KEY

echo "====================================="
echo "DEPLOYMENT COMPLETE!"
echo "Check shared/config/deployed.json for new addresses."
echo "====================================="
