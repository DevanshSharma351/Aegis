'use client';

import { useEffect, useState } from 'react';

import {
  AEGIS_VAULT_ABI,
  ASSETS,
  SESSION_KEY_POLICY,
  VAULT_ADDRESS,
  publicClient,
} from '../contracts';

/**
 * The vault's live authority configuration, read from chain.
 *
 * Every field here answers "what is this key actually allowed to do", and the
 * answers come from three places with different trust levels — which is why
 * they are labelled rather than merged:
 *
 *   on-chain    sessionKey, sessionKeySet, whitelistedAssets, owner. These are
 *               enforced by the contract.
 *   policy file the selector/value/rate constraints, enforced by the ERC-4337
 *               permission validator at validateUserOp time. Not readable from
 *               the vault, because the vault does not hold them.
 *   structural  the absence of any withdrawal function, derived from the
 *               compiled ABI rather than asserted.
 */

export interface SessionKeyPolicy {
  /** The account authorised to call rebalance. This is the ERC-4337 smart
   *  account, not the signing EOA — a UserOperation executes with
   *  msg.sender == account. */
  sessionKeyAddress: `0x${string}` | null;
  sessionKeyBound: boolean;
  owner: `0x${string}` | null;
  whitelistedAssets: readonly { symbol: string; address: string; decimals: number }[];

  maxExecutionsPerDay: number;
  rateLimitIntervalSeconds: number;
  valueLimitWei: string;
  withdrawalPermissions: string;
  allowedSelector: string;
  allowedSignature: string;

  /** Derived from the ABI: no function in the vault can move value. */
  hasNoWithdrawalFunction: boolean;

  isLoading: boolean;
  error: string | null;
}

/**
 * Check the compiled ABI for anything that could move value.
 *
 * The zero-withdrawal claim is the strongest guarantee this system makes, so the
 * UI derives it from the deployed contract's own interface rather than printing
 * a hardcoded "safe" badge. If someone later adds a transfer function, this goes
 * false on its own.
 */
function abiHasNoValueMovement(): boolean {
  // Exact names, not prefixes. A prefix match on `execute` also matches the
  // vault's `executedAt(bytes32)` replay-guard getter, which reads a timestamp
  // and moves nothing — and reporting a withdrawal function that does not exist
  // is its own kind of lie.
  const dangerous = new Set([
    'withdraw',
    'withdrawall',
    'withdrawto',
    'transfer',
    'transferfrom',
    'safetransfer',
    'safetransferfrom',
    'send',
    'sendvalue',
    'sweep',
    'rescue',
    'rescuetokens',
    'execute',
    'executebatch',
    'call',
    'delegatecall',
    'multicall',
  ]);

  const functions = (AEGIS_VAULT_ABI as readonly { type?: string; name?: string; stateMutability?: string }[])
    .filter((entry) => entry.type === 'function');

  const hasDangerousName = functions.some((fn) => dangerous.has((fn.name ?? '').toLowerCase()));
  const hasPayable = functions.some((fn) => fn.stateMutability === 'payable');
  const hasCatchAll = (AEGIS_VAULT_ABI as readonly { type?: string }[]).some(
    (entry) => entry.type === 'receive' || entry.type === 'fallback',
  );

  return !hasDangerousName && !hasPayable && !hasCatchAll;
}

export function useSessionKeyPolicy(): SessionKeyPolicy {
  const selector = SESSION_KEY_POLICY.allowedSelectors[0];

  const [state, setState] = useState<SessionKeyPolicy>({
    sessionKeyAddress: null,
    sessionKeyBound: false,
    owner: null,
    whitelistedAssets: ASSETS,
    maxExecutionsPerDay: SESSION_KEY_POLICY.maxExecutionsPerDay,
    rateLimitIntervalSeconds: SESSION_KEY_POLICY.rateLimitIntervalSeconds,
    valueLimitWei: SESSION_KEY_POLICY.valueLimitWei,
    withdrawalPermissions: SESSION_KEY_POLICY.withdrawalPermissions,
    allowedSelector: selector?.selector ?? '',
    allowedSignature: selector?.signature ?? '',
    hasNoWithdrawalFunction: abiHasNoValueMovement(),
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function read() {
      try {
        const contract = { address: VAULT_ADDRESS, abi: AEGIS_VAULT_ABI } as const;

        const [sessionKey, sessionKeySet, owner, assets] = await Promise.all([
          publicClient.readContract({ ...contract, functionName: 'sessionKey' }),
          publicClient.readContract({ ...contract, functionName: 'sessionKeySet' }),
          publicClient.readContract({ ...contract, functionName: 'owner' }),
          publicClient.readContract({ ...contract, functionName: 'whitelistedAssets' }),
        ]);

        if (cancelled) return;

        // Prefer the on-chain asset list over the config snapshot: the contract
        // is the authority on what it will hold, and the two could drift.
        const onChain = assets as readonly `0x${string}`[];
        const resolved = onChain.map((address) => {
          const known = ASSETS.find((a) => a.address.toLowerCase() === address.toLowerCase());
          return known ?? { symbol: 'UNKNOWN', address, decimals: 18 };
        });

        setState((prev) => ({
          ...prev,
          sessionKeyAddress: sessionKey as `0x${string}`,
          sessionKeyBound: sessionKeySet as boolean,
          owner: owner as `0x${string}`,
          whitelistedAssets: resolved,
          isLoading: false,
          error: null,
        }));
      } catch (error) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, isLoading: false, error: (error as Error).message }));
      }
    }

    read();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
