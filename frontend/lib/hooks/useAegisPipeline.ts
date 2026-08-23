'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drive the Aegis pipeline from the browser.
 *
 * The browser starts a job and polls it. It does not orchestrate anything: the
 * sequence lives in the enclave (`enclave/pipeline.py`), which is the same
 * sequence `scripts/run_full_pipeline.sh` runs. No trading logic, no signing,
 * and no knowledge of the internal services exists on this side.
 *
 * Every stage state here is read from the backend. Nothing advances on a timer,
 * and a failed run leaves downstream stages `pending` rather than showing them
 * as complete.
 */

const ENCLAVE_URL = process.env.NEXT_PUBLIC_ENCLAVE_URL?.trim() || 'http://localhost:8000';

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface PipelineStage {
  key: string;
  label: string;
  status: StageStatus;
  detail: string;
  durationMs: number | null;
  /** Stage-specific payload. Shape varies by stage, so it is read defensively. */
  data: Record<string, unknown>;
}

export interface PipelineJob {
  jobId: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  failedStage: string | null;
  stages: PipelineStage[];
  result: {
    decision?: {
      allocations: Record<string, number>;
      rationale: string;
      confidence: number;
      decisionHash: string;
    };
    attestation?: {
      measurement: string;
      source: string;
      hardwareVerified: boolean;
      checksPerformed: string[];
    };
    vault?: {
      txHash: string;
      userOpHash?: string;
      blockNumber: string;
      sequence: string;
      smartAccount?: string;
      explorerUrl: string;
    };
    swap?: {
      txHash: string;
      blockNumber: number;
      gasUsed: string;
      sellAmount: string;
      netSellAmount: string;
      unshieldFee: string;
      quotedBuyAmount: string;
      minimumBuyAmount: string;
      feeTier: number;
      proofDurationMs: number;
      explorerUrl: string;
      submission: { mode: string; route: string; mempoolExposed: boolean };
      /**
       * Measured from the mined block, not asserted. Whether a swap was
       * sandwiched is a property of the receipt, not of the route it took.
       */
      execution: {
        actualBuyAmount: string;
        versusQuoteBps: number;
        slippageBudgetUsedPercent: number;
        otherSwapsOnPoolInBlock: number;
        sandwichPatternObserved: boolean;
      };
    } | null;
    balances?: { symbol: string; balance: string; spendable: string; decimals: number }[];
    railgunAddress?: string;
  };
}

export function useAegisPipeline() {
  const [job, setJob] = useState<PipelineJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const run = useCallback(
    async (params: { sellAmount: string; slippageBps?: number; skipSwap?: boolean }) => {
      setStarting(true);
      setStartError(null);
      setJob(null);

      try {
        const response = await fetch(`${ENCLAVE_URL}/pipeline/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sellAmount: params.sellAmount,
            slippageBps: params.slippageBps ?? 150,
            skipSwap: params.skipSwap ?? false,
          }),
        });

        const body = await response.json();
        if (!response.ok) {
          throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body));
        }

        setJob(body as PipelineJob);

        // Poll until the backend reports a terminal state. 2s is well under the
        // shortest stage, so the UI never skips a transition.
        stopPolling();
        pollRef.current = setInterval(async () => {
          try {
            const poll = await fetch(`${ENCLAVE_URL}/pipeline/${body.jobId}`);
            if (!poll.ok) return;
            const next = (await poll.json()) as PipelineJob;
            setJob(next);
            if (next.status !== 'running') stopPolling();
          } catch {
            // A transient poll failure is not a pipeline failure; the run
            // continues server-side and the next tick will pick it up.
          }
        }, 2000);

        return body as PipelineJob;
      } catch (error) {
        setStartError((error as Error).message);
        return null;
      } finally {
        setStarting(false);
      }
    },
    [stopPolling],
  );

  const reset = useCallback(() => {
    stopPolling();
    setJob(null);
    setStartError(null);
  }, [stopPolling]);

  return { run, reset, job, starting, startError, isRunning: job?.status === 'running' };
}

/**
 * Shield funds into the 0zk wallet.
 *
 * Resolves only once the transaction is mined, so the hash is always backed by
 * a receipt. There is no optimistic state.
 */
export function useShieldFunds() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{
    txHash: string;
    blockNumber: number;
    gasUsed: string;
    amount: string;
    symbol: string;
    recipient0zk: string;
    explorerUrl: string;
    approvalTxHash?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shield = useCallback(async (token: string, amount: string) => {
    setPhase('running');
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`${ENCLAVE_URL}/railgun/shield`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, amount }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body));
      }

      setResult(body);
      setPhase('done');
      return body;
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setError(null);
  }, []);

  return { shield, reset, phase, result, error };
}
