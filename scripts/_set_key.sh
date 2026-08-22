#!/bin/bash
# Script to call setSessionKey on AegisVault

ALCHEMY_API_KEY="alch_d7S3t4hyopu2nVcbaMwre"
DEPLOYER_PRIVATE_KEY="0xdc4597ee1df51a90e7a9c08c8b68aee2abda068e199113fd71ff4b137567f4ee"
AEGIS_VAULT_ADDRESS="0x74386Acb93D382c940c015F1ad9329E13b7D5cA4"
KERNEL_SMART_ACCOUNT="0x61e7eDBD1C14C7F0B14513958e94d9f58770E662"
RPC_URL="https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}"

echo "=> Setting session key on AegisVault..."
echo "   Vault:   $AEGIS_VAULT_ADDRESS"
echo "   Key:     $KERNEL_SMART_ACCOUNT"

~/.foundry/bin/cast send \
    "$AEGIS_VAULT_ADDRESS" \
    "setSessionKey(address)" \
    "$KERNEL_SMART_ACCOUNT" \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_PRIVATE_KEY"

echo "=> Done!"
