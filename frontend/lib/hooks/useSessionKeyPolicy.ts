'use client';

import { useState, useEffect } from 'react';

/**
 * Reads AegisVault's sessionKey + whitelisted assets directly from chain via viem.
 * No backend dependency — pure on-chain reads.
 * 
 * Until contracts are deployed, returns mock policy data matching
 * shared/config/policy.json for UI development.
 */

export interface SessionKeyPolicy {
  sessionKeyAddress: string | null;
  maxExecutionsPerDay: number;
  valueLimit: string;
  withdrawalPermissions: string;
  whitelistedAssets: string[];
  isLoading: boolean;
}

export function useSessionKeyPolicy(): SessionKeyPolicy {
  const [policy, setPolicy] = useState<SessionKeyPolicy>({
    sessionKeyAddress: null,
    maxExecutionsPerDay: 0,
    valueLimit: '0',
    withdrawalPermissions: 'NONE',
    whitelistedAssets: [],
    isLoading: true,
  });

  useEffect(() => {
    // Mock data matching shared/config/policy.json
    // In production: read from AegisVault contract via viem
    const timer = setTimeout(() => {
      setPolicy({
        sessionKeyAddress: null, // Filled once Workstream B deploys
        maxExecutionsPerDay: 1,
        valueLimit: '0',
        withdrawalPermissions: 'NONE',
        whitelistedAssets: [
          '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH
          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // USDC
        ],
        isLoading: false,
      });
    }, 600);

    return () => clearTimeout(timer);
  }, []);

  return policy;
}
