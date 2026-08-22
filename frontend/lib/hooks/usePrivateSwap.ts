'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Private swap: status and execution, through the enclave.
 *
 * The browser never talks to the Railgun sidecar directly. The sidecar holds the
 * wallet mnemonic and sits on an internal-only Docker network; the enclave is
 * the single service on both networks and acts as the controlled entry point.
 *
 * Every status here is reported by the component that did the work and passed
 * through unmodified. Nothing is inferred client-side, because the two things a
 * user most needs to trust — whether POI was genuinely enforced, and whether the
 * transaction avoided the public mempool — are exactly the two a UI would be
 * tempted to present optimistically.
 */

const ENCLAVE_URL =
  process.env.NEXT_PUBLIC_ENCLAVE_URL?.trim() || 'http://localhost:8000';

/** Whether the required Chainalysis POI list was actually enforced. */
export type PoiMode = 'real' | 'unconfigured' | 'unknown';

/** Whether the transaction went through the public mempool. */
export type SubmissionMode = 'public' | 'private' | 'unknown';

export interface RailgunStatus {
  reachable: boolean;
  engineReady: boolean;

  poi: {
    mode: PoiMode;
    nodeUrls: string[];
    requiredList: string;
    note: string;
  };

  submission: {
    mode: SubmissionMode;
    route: string;
    /** True = a searcher can see this transaction before it lands. */
    mempoolExposed: boolean;
  } | null;

  canSwap: boolean;
  error: string | null;
  isLoading: boolean;
}

export interface ShieldedBalance {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  /** Subset that POI has validated. A fresh note is not spendable yet. */
  spendable: string;
}

export interface PrivateSwapResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  netSellAmount: string;
  unshieldFee: string;
  quotedBuyAmount: string;
  minimumBuyAmount: string;
  feeTier: number;
  proofDurationMs: number;
  relayAdaptContract: string;
  explorerUrl: string;
  recipient0zk: string;
  submission: { mode: SubmissionMode; route: string; mempoolExposed: boolean };
}

const UNKNOWN_STATUS: RailgunStatus = {
  reachable: false,
  engineReady: false,
  poi: { mode: 'unknown', nodeUrls: [], requiredList: '', note: '' },
  submission: null,
  canSwap: false,
  error: null,
  isLoading: true,
};

export function useRailgunStatus(pollMs = 20_000): RailgunStatus {
  const [status, setStatus] = useState<RailgunStatus>(UNKNOWN_STATUS);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      try {
        const response = await fetch(`${ENCLAVE_URL}/railgun/status`, {
          headers: { Accept: 'application/json' },
        });
        const body = await response.json();
        if (cancelled) return;

        setStatus({
          reachable: true,
          engineReady: Boolean(body.engineReady),
          poi: {
            mode: (body.poi?.mode as PoiMode) ?? 'unknown',
            nodeUrls: body.poi?.nodeUrls ?? [],
            requiredList: body.poi?.requiredList ?? '',
            note: body.poi?.note ?? '',
          },
          submission: body.submission ?? null,
          canSwap: Boolean(body.capabilities?.unshieldSwapReshield),
          error: body.error ?? null,
          isLoading: false,
        });
      } catch (error) {
        if (cancelled) return;
        // Unreachable is reported as unreachable. It is never treated as
        // "probably fine".
        setStatus({
          ...UNKNOWN_STATUS,
          isLoading: false,
          error: `Enclave unreachable at ${ENCLAVE_URL}: ${(error as Error).message}`,
        });
      }
    }

    read();
    const timer = setInterval(read, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return status;
}

export function useShieldedBalances() {
  const [balances, setBalances] = useState<ShieldedBalance[]>([]);
  const [railgunAddress, setRailgunAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`${ENCLAVE_URL}/railgun/balances`);
        const body = await response.json();
        if (cancelled) return;

        if (!response.ok) throw new Error(body.detail ?? 'balance read failed');

        setBalances(body.balances ?? []);
        setRailgunAddress(body.railgunAddress ?? null);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { balances, railgunAddress, isLoading, error, refresh };
}

export type SwapPhase = 'idle' | 'running' | 'done' | 'error';

/**
 * Execute one atomic unshield → swap → reshield.
 *
 * There is no optimistic state and no synthetic hash. The request does not
 * resolve until the transaction is mined, so `result` is either absent or backed
 * by a real receipt. `phase` stays `running` for the whole 1-3 minutes of proof
 * generation rather than showing a fabricated pending confirmation.
 */
export function usePrivateSwap() {
  const [phase, setPhase] = useState<SwapPhase>('idle');
  const [result, setResult] = useState<PrivateSwapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const execute = useCallback(
    async (params: { sellToken: string; buyToken: string; sellAmount: string; slippageBps?: number }) => {
      setPhase('running');
      setError(null);
      setResult(null);
      setStartedAt(Date.now());

      try {
        const response = await fetch(`${ENCLAVE_URL}/railgun/private-swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slippageBps: 150, ...params }),
        });

        const body = await response.json();

        if (!response.ok) {
          // 501 means the capability is switched off (e.g. no POI aggregator),
          // which is a deployment gap rather than a failed trade.
          throw new Error(
            typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body),
          );
        }

        setResult(body as PrivateSwapResult);
        setPhase('done');
        return body as PrivateSwapResult;
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setError(null);
    setStartedAt(null);
  }, []);

  return { execute, reset, phase, result, error, startedAt };
}

/**
 * Format a base-unit integer for display.
 *
 * Truncating to a fixed number of fraction digits renders any value smaller
 * than the cutoff as "0" — which turned a real 915750000000 wei unshield fee
 * into a displayed fee of zero. A non-zero amount must never render as zero, so
 * when truncation would erase the value entirely, precision is extended until
 * the first significant digit appears.
 */
export function formatUnits(value: string, decimals: number, maxFractionDigits = 6): string {
  try {
    const negative = value.startsWith('-');
    const digits = negative ? value.slice(1) : value;
    const padded = digits.padStart(decimals + 1, '0');

    const whole = padded.slice(0, padded.length - decimals);
    const allFraction = padded.slice(padded.length - decimals);

    let cut = maxFractionDigits;
    if (whole === '0' && /[1-9]/.test(allFraction)) {
      // Extend past the leading zeros so a small non-zero value stays visible.
      const firstSignificant = allFraction.search(/[1-9]/);
      cut = Math.max(maxFractionDigits, Math.min(firstSignificant + 3, decimals));
    }

    const fraction = allFraction.slice(0, cut).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
  } catch {
    return value;
  }
}
