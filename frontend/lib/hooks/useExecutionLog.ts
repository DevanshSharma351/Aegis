'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseAbiItem } from 'viem';

import {
  AEGIS_VAULT_ABI,
  DEPLOYED_AT_BLOCK,
  VAULT_ADDRESS,
  logClient,
  publicClient,
} from '../contracts';

/**
 * The on-chain execution log: every RebalanceExecuted event, live from Sepolia.
 *
 * PRIVACY CONSTRAINT — this is a deliberate design property, not a gap.
 *
 * The event carries a decision hash, a timestamp, and a sequence number. There
 * is no amount field, no allocation, no asset identifier, because AegisVault
 * never emits one. This hook renders exactly what is on-chain and does not go
 * looking for balances elsewhere to enrich it. An observer learns *that* the
 * agent acted and *when*, and can verify the decision was attested — and learns
 * nothing about the position. The real movement happens inside Railgun's
 * shielded pool, so there is no public counterpart to correlate against.
 *
 * If you are tempted to add amounts here, that is the feature being removed.
 */

export interface ExecutionLogEntry {
  decisionHash: `0x${string}`;
  /** Seconds since epoch, as recorded by the contract. */
  timestamp: number;
  sequence: number;
  txHash: `0x${string}`;
  blockNumber: number;
}

export interface ExecutionLog {
  entries: ExecutionLogEntry[];
  /** Vault's own counter. Cross-checks that no event was missed. */
  rebalanceCount: number | null;
  lastRebalanceAt: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

const REBALANCE_EVENT = parseAbiItem(
  'event RebalanceExecuted(bytes32 indexed decisionHash, uint256 timestamp, uint256 sequence)',
);

export function useExecutionLog(pollMs = 20_000): ExecutionLog {
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [rebalanceCount, setRebalanceCount] = useState<number | null>(null);
  const [lastRebalanceAt, setLastRebalanceAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      try {
        // The counter and timestamp come from ordinary reads, which work on any
        // RPC. They are fetched even if the log query fails, so the UI can still
        // show that N rebalances happened.
        const contract = { address: VAULT_ADDRESS, abi: AEGIS_VAULT_ABI } as const;
        const [count, lastAt] = await Promise.all([
          publicClient.readContract({ ...contract, functionName: 'rebalanceCount' }),
          publicClient.readContract({ ...contract, functionName: 'lastRebalanceAt' }),
        ]);

        if (!cancelled) {
          setRebalanceCount(Number(count as bigint));
          setLastRebalanceAt(Number(lastAt as bigint));
        }

        // Logs go through logClient: see contracts.ts for why this cannot use
        // the Alchemy free tier.
        const logs = await logClient.getLogs({
          address: VAULT_ADDRESS,
          event: REBALANCE_EVENT,
          fromBlock: DEPLOYED_AT_BLOCK,
          toBlock: 'latest',
        });

        if (cancelled) return;

        const parsed: ExecutionLogEntry[] = logs
          .map((log) => ({
            decisionHash: log.args.decisionHash as `0x${string}`,
            timestamp: Number(log.args.timestamp as bigint),
            sequence: Number(log.args.sequence as bigint),
            txHash: log.transactionHash as `0x${string}`,
            blockNumber: Number(log.blockNumber),
          }))
          .sort((a, b) => b.sequence - a.sequence);

        setEntries(parsed);
        setIsLoading(false);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Degrade rather than crash: the counter above may still have loaded,
        // and a blank log with an explanation beats a blank page.
        setIsLoading(false);
        setError((err as Error).message);
      }
    }

    read();
    const interval = setInterval(read, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs, nonce]);

  return { entries, rebalanceCount, lastRebalanceAt, isLoading, error, refresh };
}

/** "2 hours ago" style formatting for a unix timestamp in seconds. */
export function relativeTime(unixSeconds: number): string {
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
