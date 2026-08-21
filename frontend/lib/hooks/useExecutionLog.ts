'use client';

import { useState, useEffect } from 'react';

/**
 * Subscribes to RebalanceExecuted events via viem's watchContractEvent / getLogs.
 * Renders hash + timestamp ONLY — explicitly does NOT fetch or display any
 * amount/balance data, even if it were technically retrievable elsewhere.
 * 
 * This is a deliberate privacy-preserving UI constraint, not a missing feature.
 * The system's value proposition is that trade amounts are hidden from everyone,
 * including the frontend operator. Displaying only the decision hash and timestamp
 * proves execution happened without revealing what was traded or how much.
 */

export interface ExecutionLogEntry {
  decisionHash: string;
  timestamp: number;
  txHash: string;
}

export function useExecutionLog(): {
  entries: ExecutionLogEntry[];
  isLoading: boolean;
  latestTimestamp: number | null;
} {
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Mock execution log entries for UI development.
    // In production: subscribe to RebalanceExecuted events via viem.
    const timer = setTimeout(() => {
      setEntries([
        {
          decisionHash: '0x7a3f...9e2b',
          timestamp: Date.now() / 1000 - 3600,
          txHash: '0xabc1...def2',
        },
        {
          decisionHash: '0x4b1c...8d3f',
          timestamp: Date.now() / 1000 - 86400,
          txHash: '0x123a...456b',
        },
      ]);
      setIsLoading(false);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  return {
    entries,
    isLoading,
    latestTimestamp: entries.length > 0 ? entries[0].timestamp : null,
  };
}
