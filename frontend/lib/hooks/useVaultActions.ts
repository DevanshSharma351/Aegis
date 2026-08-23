'use client';

import { useCallback, useState } from 'react';
import { useAccount, usePublicClient, useSignMessage, useWalletClient } from 'wagmi';
import type { Address, Hex } from 'viem';

/**
 * Deposit and withdraw, signed by the connected wallet.
 *
 * WHY THE BROWSER SIGNS THESE AND NOT THE PIPELINE
 *
 * Everything the agent does on its own -- deciding, attesting, rebalancing,
 * swapping -- runs server-side, because those keys must never reach a browser.
 * Moving a user's own money is the opposite case: it must be authorised by the
 * user's own key, and the server must never hold it.
 *
 * So the split is by authority rather than convenience. The sidecar builds the
 * shield calldata, because it is the side with the Railgun engine. The wallet
 * signs and sends it, because it is the side with the money. Neither gains
 * anything the other holds, and the deposit appears on-chain as a transaction
 * from the depositor's address.
 *
 * Withdrawal is the reverse: spending a shielded note needs a Groth16 proof
 * over the commitment tree, which only the sidecar can produce, so the browser
 * asks for it and names the address to pay.
 */

const ENCLAVE_URL = process.env.NEXT_PUBLIC_ENCLAVE_URL?.trim() || 'http://localhost:8000';

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ENCLAVE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload),
    );
  }
  return payload as T;
}

export type DepositStep =
  | 'idle'
  | 'signing'
  | 'building'
  | 'approving'
  | 'shielding'
  | 'done'
  | 'error';

export interface DepositResult {
  txHash: Hex;
  approvalTxHash?: Hex;
  amount: string;
  symbol: string;
  recipient0zk: string;
}

export function useDeposit() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();

  const [step, setStep] = useState<DepositStep>('idle');
  const [result, setResult] = useState<DepositResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deposit = useCallback(
    async (token: string, amount: string) => {
      setError(null);
      setResult(null);

      if (!walletClient || !address || !publicClient) {
        setError('Connect a wallet first.');
        setStep('error');
        return null;
      }

      try {
        // 1. Railgun derives the note-encryption key from a signature over a
        //    fixed string. It authorises nothing -- it is not a transaction --
        //    but it must come from the depositing wallet.
        setStep('signing');
        const { message } = await (
          await fetch(`${ENCLAVE_URL}/railgun/shield/message`)
        ).json();
        const signature = await signMessageAsync({ message });

        // 2. The sidecar has the engine, so it builds the calls.
        setStep('building');
        const prepared = await post<{
          approve: { to: Address; data: Hex; value: string } | null;
          shield: { to: Address; data: Hex; value: string };
          recipient0zk: string;
          symbol: string;
          amount: string;
        }>('/railgun/shield/prepare', { token, amount, from: address, signature });

        // 3. ERC-20 has no way to authorise a pull inside the same transaction,
        //    so an approval is a separate send when the allowance is short.
        let approvalTxHash: Hex | undefined;
        if (prepared.approve) {
          setStep('approving');
          approvalTxHash = await walletClient.sendTransaction({
            to: prepared.approve.to,
            data: prepared.approve.data,
          });
          await publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
        }

        setStep('shielding');
        const txHash = await walletClient.sendTransaction({
          to: prepared.shield.to,
          data: prepared.shield.data,
        });

        // Resolve only on a receipt, so a returned hash is always mined.
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
          throw new Error(`Shield transaction ${txHash} reverted`);
        }

        const done: DepositResult = {
          txHash,
          approvalTxHash,
          amount: prepared.amount,
          symbol: prepared.symbol,
          recipient0zk: prepared.recipient0zk,
        };
        setResult(done);
        setStep('done');
        return done;
      } catch (err) {
        // Wallet rejections are a normal outcome, not a failure worth shouting
        // about, but they must still leave the UI in a truthful state.
        const message = (err as Error).message ?? String(err);
        setError(/User rejected|denied/i.test(message) ? 'Signature rejected in wallet.' : message);
        setStep('error');
        return null;
      }
    },
    [address, walletClient, publicClient, signMessageAsync],
  );

  const reset = useCallback(() => {
    setStep('idle');
    setResult(null);
    setError(null);
  }, []);

  return { deposit, reset, step, result, error, address };
}

export interface WithdrawResult {
  txHash: string;
  symbol: string;
  amount: string;
  netAmount: string;
  unshieldFee: string;
  recipient: string;
  proofDurationMs: number;
  explorerUrl: string;
}

export function useWithdraw() {
  const { address } = useAccount();
  const [phase, setPhase] = useState<'idle' | 'proving' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(
    async (token: string, amount: string, recipient?: string) => {
      const to = recipient ?? address;
      if (!to) {
        setError('Connect a wallet, or give an address to withdraw to.');
        setPhase('error');
        return null;
      }

      setPhase('proving');
      setError(null);
      setResult(null);

      try {
        // No optimistic state: this resolves only once the proof is generated
        // and the transaction is mined.
        const body = await post<WithdrawResult>('/railgun/unshield', {
          token,
          amount,
          recipient: to,
        });
        setResult(body);
        setPhase('done');
        return body;
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
        return null;
      }
    },
    [address],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setResult(null);
    setError(null);
  }, []);

  return { withdraw, reset, phase, result, error, address };
}
