/**
 * Typed contract access for AegisVault and AttestationVerifier.
 *
 * ABIs and addresses come from lib/generated/deployment.ts, which
 * scripts/sync_frontend_config.py writes from shared/abi and shared/config. The
 * previous version of this file hand-wrote ABI fragments and left the addresses
 * as empty strings; a hand-written ABI that drifts from the deployed bytecode
 * produces decode failures that look like network errors.
 */

import { Chain, createPublicClient, defineChain, http } from 'viem';
import { sepolia } from 'viem/chains';

import {
  ADDRESSES,
  AEGIS_VAULT_ABI,
  ATTESTATION_VERIFIER_ABI,
  ATTESTATION_SOURCE,
  BLOCK_EXPLORER,
  CHAIN_ID,
  DEPLOYED_AT_BLOCK,
  EXPECTED_MEASUREMENT,
  ASSETS,
  SESSION_KEY_POLICY,
} from './generated/deployment';

export {
  ADDRESSES,
  AEGIS_VAULT_ABI,
  ATTESTATION_VERIFIER_ABI,
  ATTESTATION_SOURCE,
  BLOCK_EXPLORER,
  CHAIN_ID,
  DEPLOYED_AT_BLOCK,
  EXPECTED_MEASUREMENT,
  ASSETS,
  SESSION_KEY_POLICY,
};

export const VAULT_ADDRESS = ADDRESSES.aegisVault as `0x${string}`;
export const VERIFIER_ADDRESS = ADDRESSES.attestationVerifier as `0x${string}`;

export const chain: Chain =
  CHAIN_ID === sepolia.id
    ? sepolia
    : defineChain({
        id: CHAIN_ID,
        name: 'Aegis Network',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } },
      });

/**
 * RPC endpoints, in priority order.
 *
 * `NEXT_PUBLIC_ALCHEMY_API_KEY` is optional. Everything here is a public read,
 * so a keyless public endpoint is a perfectly good default and means the site
 * works with no configuration at all.
 */
function readRpcUrls(): string[] {
  const urls: string[] = [];

  const explicit = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  if (explicit) urls.push(explicit);

  const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim();
  if (alchemyKey) urls.push(`https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`);

  urls.push('https://ethereum-sepolia-rpc.publicnode.com');
  return [...new Set(urls)];
}

/** Client for ordinary contract reads. */
export const publicClient = createPublicClient({
  chain,
  transport: http(readRpcUrls()[0], { timeout: 20_000, retryCount: 2 }),
});

/**
 * A separate client for log queries.
 *
 * Alchemy's free tier caps `eth_getLogs` at a **10 block range** and rejects
 * anything wider:
 *
 *     "Under the Free tier plan, you can make eth_getLogs requests with up to a
 *      10 block range."
 *
 * The execution log needs every event since deployment, which is thousands of
 * blocks. Chunking that into 10-block windows would be hundreds of requests, so
 * log queries go to a public endpoint that serves the full range in one call
 * instead. Ordinary reads still use the configured primary.
 */
export const logClient = createPublicClient({
  chain,
  transport: http('https://ethereum-sepolia-rpc.publicnode.com', {
    timeout: 30_000,
    retryCount: 2,
  }),
});

export const explorerTx = (hash: string) => `${BLOCK_EXPLORER}/tx/${hash}`;
export const explorerAddress = (address: string) => `${BLOCK_EXPLORER}/address/${address}`;

/** Shorten a hash for display without implying the full value is unavailable. */
export function truncateHash(value: string, lead = 10, tail = 8): string {
  if (!value || value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
