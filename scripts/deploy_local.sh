#!/bin/bash
set -a
source ../.env
set +a
~/.foundry/bin/anvil --fork-url https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY > /tmp/anvil.log 2>&1 &
sleep 5
cd ../contracts
~/.foundry/bin/forge script script/Deploy.s.sol:DeployScript --rpc-url http://localhost:8545 --broadcast --private-key $DEPLOYER_PRIVATE_KEY
