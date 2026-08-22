'use client';

import { useEffect, useState } from 'react';

import {
  ATTESTATION_SOURCE,
  ATTESTATION_VERIFIER_ABI,
  EXPECTED_MEASUREMENT,
  VERIFIER_ADDRESS,
  publicClient,
} from '../contracts';

/**
 * Live attestation status, read from AttestationVerifier on-chain.
 *
 * Two independent facts, deliberately kept apart because they answer different
 * questions:
 *
 *   `source`      Did the quote come from real TDX hardware, or the dstack
 *                 simulator? Recorded at deploy time in deployed.json. A
 *                 simulator quote exercises every code path in the pipeline and
 *                 proves nothing whatsoever about hardware, so this is stated
 *                 rather than implied — the UI must never show a hardware badge
 *                 for a simulator run.
 *
 *   `matches`     Does the measurement burned into the contract still equal the
 *                 one this build was deployed against? A mismatch means the
 *                 enclave image changed without the on-chain constant being
 *                 rotated, and every rebalance would currently revert.
 *
 * This is a pure on-chain read plus a build-time constant. No backend.
 */

export type AttestationSource = 'simulator' | 'hardware-tdx' | 'unknown';

export interface AttestationStatus {
  /** Provenance of the attestation. Never inferred. */
  source: AttestationSource;
  /** Measurement currently enforced by the deployed contract. */
  onChainMeasurement: `0x${string}` | null;
  /** Measurement this frontend build was generated against. */
  expectedMeasurement: string;
  /** Whether the two agree. `null` while loading or unreachable. */
  matches: boolean | null;
  isLoading: boolean;
  error: string | null;
}

export function useAttestationStatus(): AttestationStatus {
  const [state, setState] = useState<AttestationStatus>({
    source: ATTESTATION_SOURCE as AttestationSource,
    onChainMeasurement: null,
    expectedMeasurement: EXPECTED_MEASUREMENT,
    matches: null,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function read() {
      try {
        const measurement = (await publicClient.readContract({
          address: VERIFIER_ADDRESS,
          abi: ATTESTATION_VERIFIER_ABI,
          functionName: 'expectedMeasurement',
        })) as `0x${string}`;

        if (cancelled) return;

        setState((prev) => ({
          ...prev,
          onChainMeasurement: measurement,
          matches: measurement.toLowerCase() === EXPECTED_MEASUREMENT.toLowerCase(),
          isLoading: false,
          error: null,
        }));
      } catch (error) {
        if (cancelled) return;
        // Degrade to "unknown" rather than to a green tick: an unreachable RPC
        // is not evidence that the attestation is valid.
        setState((prev) => ({
          ...prev,
          matches: null,
          isLoading: false,
          error: (error as Error).message,
        }));
      }
    }

    read();
    const interval = setInterval(read, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return state;
}

/** Human-readable label for a source, for badges. */
export function attestationSourceLabel(source: AttestationSource): string {
  switch (source) {
    case 'hardware-tdx':
      return 'Hardware TDX';
    case 'simulator':
      return 'Simulator';
    default:
      return 'Unknown';
  }
}
