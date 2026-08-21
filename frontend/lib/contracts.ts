/**
 * Typed contract configuration for AegisVault and AttestationVerifier.
 * 
 * Reads addresses from shared/config/deployed.json and ABIs from shared/abi/.
 * These are placeholder ABIs until the contracts are compiled by Workstream D.
 * Once compiled, swap in the real ABIs and this module automatically provides
 * typed contract instances to all frontend hooks.
 */

// Placeholder ABI fragments — the minimum needed for the frontend hooks.
// Replace with full compiled ABIs from shared/abi/ once Workstream D is done.
export const AEGIS_VAULT_ABI = [
  {
    name: 'sessionKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'RebalanceExecuted',
    type: 'event',
    inputs: [
      { name: 'decisionHash', type: 'bytes32', indexed: true },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ATTESTATION_VERIFIER_ABI = [
  {
    name: 'expectedMeasurement',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'verify',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'decisionHash', type: 'bytes32' },
      { name: 'attestationProof', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * Contract addresses — read from deployed.json.
 * Empty strings mean contracts haven't been deployed yet;
 * the hooks handle this gracefully with fallback states.
 */
export const CONTRACT_ADDRESSES = {
  aegisVault: '' as `0x${string}` | '',
  attestationVerifier: '' as `0x${string}` | '',
} as const;

/** Sepolia chain ID */
export const CHAIN_ID = 11155111;
