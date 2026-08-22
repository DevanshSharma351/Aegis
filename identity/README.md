# Aegis Identity (Workstream B)

This directory contains the identity layer for Aegis, powered by ERC-4337 (ZeroDev Kernel smart accounts) and Pimlico (Bundler/Paymaster).

The core function of this workstream is to generate and provision a restricted Session Key that allows the enclave (Workstream A) to execute rebalance decisions on the `AegisVault` (Workstream D) without having full control over the owner account.

## Setup

1. Copy the root `.env.example` to `.env` and fill in the required keys:
   - `ALCHEMY_API_KEY`: RPC endpoint (Sepolia)
   - `PIMLICO_API_KEY`: Bundler/Paymaster
   - `ZERODEV_PROJECT_ID`: ZeroDev project (Kernel v3)
   - `AEGIS_OWNER_PRIVATE_KEY`: Your EOA that owns the smart account and Vault.
   - `SESSION_KEY_PRIVATE_KEY`: The throwaway private key for the session key.

2. Install dependencies:
   ```bash
   npm install
   ```

## Bootstrap Sequence (The Circular Dependency)

Because the Session Key needs to know the Vault's address to lock down its permissions (target restriction), but the Vault needs the Session Key's address to enforce access control, we must use a **two-phase deployment**.

Follow this exact sequence to bootstrap the system:

### 1. Deploy the Vault (Workstream D)
First, ensure that `AegisVault` has been deployed via Foundry and that `shared/config/deployed.json` exists with the `AegisVault` address. At this stage, the Vault's `sessionKey` state variable is unset (`address(0)`).

### 2. Generate the Session Key
Run the `createSessionKey` script to generate a session key scoped precisely to the Vault address deployed in Step 1.

```bash
npx tsx src/createSessionKey.ts
```

This will print the **Session Key Public Address** and serialize the permission state. The private key remains loaded from the `.env` (in production, it should be derived from the TEE using `dstack-sdk`).

### 3. Bind the Session Key to the Vault
Now that the session key is created, the Vault Owner must register it on the `AegisVault` contract. **This action is irreversible.**

```bash
npx tsx src/setVaultSessionKey.ts
```

You will be prompted to confirm the transaction. Once mined, the Vault is permanently locked to this session key.

### 4. Verify the Configuration
Verify the setup by reading the Vault contract on-chain (e.g., via Sepolia Etherscan or `cast`):
```bash
cast call <VAULT_ADDRESS> "sessionKey()(address)" --rpc-url https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY
```
Ensure the returned address matches the Session Key Public Address generated in Step 2.

## Security Considerations

- **Private Keys**: The `SESSION_KEY_PRIVATE_KEY` must never be logged or committed. In production, `deriveSessionKeyFromTEE()` in `createSessionKey.ts` must be upgraded to dynamically derive the key using `dstack-sdk` so that it is bound to the enclave's hardware measurement.
- **On-chain Enforcement**: While the ZeroDev SDK simulates policy enforcement client-side, the real security backstop is the on-chain session key validator module. It will revert any UserOperations that violate the rate limit or allowed selectors.
