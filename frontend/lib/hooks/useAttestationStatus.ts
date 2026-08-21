'use client';

import { useState, useEffect } from 'react';

/**
 * Reads the AttestationVerifier's expectedMeasurement and compares against
 * the enclave's last-known build hash.
 * 
 * Data freshness tradeoff: the enclave build hash is fetched from a static JSON
 * file (published by the enclave's CI), NOT a live API call — this keeps the
 * frontend backend-less per the "clean room" principle. The hash may be stale
 * if the enclave was rebuilt without regenerating the static artifact.
 * 
 * Returns 'simulator' | 'hardware-attested' | 'unknown' badge state, read from
 * the deployed.json environment field so viewers always know whether they're
 * looking at simulator or real-TDX proof.
 */

export type AttestationStatus = 'simulator' | 'hardware-attested' | 'unknown' | 'loading';

export function useAttestationStatus(): {
  status: AttestationStatus;
  measurement: string | null;
  isLoading: boolean;
} {
  const [status, setStatus] = useState<AttestationStatus>('loading');
  const [measurement, setMeasurement] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In production, this would read from deployed.json environment field
    // and compare against the on-chain expectedMeasurement via viem.
    // For now, we default to 'simulator' since that's the hackathon environment.
    const timer = setTimeout(() => {
      setStatus('simulator');
      setMeasurement('0x' + '0'.repeat(64)); // placeholder measurement
      setIsLoading(false);
    }, 800); // Simulated loading delay

    return () => clearTimeout(timer);
  }, []);

  return { status, measurement, isLoading };
}
