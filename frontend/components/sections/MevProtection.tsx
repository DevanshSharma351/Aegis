'use client';

import React from 'react';
import { CheckCircle2, EyeOff, Layers, ShieldAlert, XCircle } from 'lucide-react';

/**
 * MEV posture, stated as layers with real status rather than one claim.
 *
 * The honest position is not "protected" or "exposed" — it is that three
 * separate controls each remove part of the attack, two of them unconditionally,
 * and that the outcome of any given swap is *measurable* rather than asserted.
 *
 * Nothing here is decorative: `submission` comes from the sidecar's own report
 * of the route it actually used, and `execution` is read out of the mined block.
 */

export interface MevExecution {
  actualBuyAmount: string;
  versusQuoteBps: number;
  slippageBudgetUsedPercent: number;
  otherSwapsOnPoolInBlock: number;
  sandwichPatternObserved: boolean;
}

type LayerState = 'active' | 'partial' | 'inactive';

function Layer({
  state,
  title,
  detail,
}: {
  state: LayerState;
  title: string;
  detail: string;
}) {
  const icon =
    state === 'active' ? (
      <CheckCircle2 className="w-4 h-4 text-shield-green shrink-0 mt-0.5" />
    ) : state === 'partial' ? (
      <ShieldAlert className="w-4 h-4 text-info shrink-0 mt-0.5" />
    ) : (
      <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
    );

  return (
    <div className="flex gap-2.5 items-start">
      {icon}
      <div className="min-w-0">
        <p className="text-[11px] text-white/90 font-medium">{title}</p>
        <p className="text-[10.5px] text-muted leading-relaxed">{detail}</p>
      </div>
    </div>
  );
}

export function MevProtection({
  mempoolExposed,
  route,
  execution,
  minimumBuyAmount,
  buySymbol = 'USDC',
}: {
  mempoolExposed: boolean | null;
  route: string | null;
  execution?: MevExecution | null;
  minimumBuyAmount?: string;
  buySymbol?: string;
}) {
  const priv = mempoolExposed === false;

  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-accent" />
        <p className="text-[10px] text-muted uppercase tracking-wider">
          Sandwich resistance
        </p>
      </div>

      <Layer
        state="active"
        title="Atomic execution"
        detail="Unshield, swap and reshield are one transaction. No one can place a transaction between the legs, so the funds are never exposed mid-flight."
      />

      <Layer
        state="active"
        title="On-chain slippage floor"
        detail={
          minimumBuyAmount
            ? `Uniswap reverts below ${minimumBuyAmount} ${buySymbol}. This is enforced by the pool, not by us — it caps what any sandwich can extract.`
            : 'Uniswap reverts below the minimum output. Enforced by the pool, not by us — it caps what any sandwich can extract.'
        }
      />

      <Layer
        state={priv ? 'active' : 'partial'}
        title={priv ? 'Private submission' : 'Public submission'}
        detail={
          priv
            ? `${route ?? 'private relay'}. The transaction never enters the public mempool, so there is no pending transaction to observe or target.`
            : `${route ?? 'public RPC'}. The transaction is visible before it lands, so the first two layers are what bound the risk. Sepolia has no MEV builder able to include a private transaction — verified by sending one — so private submission there would gain privacy at the cost of never being mined.`
        }
      />

      {execution && (
        <div className="pt-3 mt-1 border-t border-white/5 space-y-2">
          <div className="flex items-center gap-2">
            <EyeOff className="w-3.5 h-3.5 text-muted" />
            <p className="text-[10px] text-muted uppercase tracking-wider">
              Measured outcome of this swap
            </p>
          </div>

          <Layer
            state={execution.sandwichPatternObserved ? 'inactive' : 'active'}
            title={
              execution.sandwichPatternObserved
                ? 'Sandwich pattern present'
                : 'No sandwich occurred'
            }
            detail={
              execution.sandwichPatternObserved
                ? `Another party traded this pool both before and after this swap in the same block — the shape of a sandwich. Realised ${execution.versusQuoteBps} bps against quote.`
                : execution.otherSwapsOnPoolInBlock === 0
                  ? 'No other transaction touched this pool in this block, so no sandwich was possible around it.'
                  : `${execution.otherSwapsOnPoolInBlock} other swap(s) hit this pool in this block, but not on both sides of ours — not a sandwich.`
            }
          />

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-[10.5px]">
            <span className="text-muted">Realised vs quote</span>
            <span
              className={`text-right font-mono ${
                execution.versusQuoteBps < -50 ? 'text-amber-400' : 'text-white/90'
              }`}
            >
              {execution.versusQuoteBps >= 0 ? '+' : ''}
              {execution.versusQuoteBps} bps
            </span>
            <span className="text-muted">Slippage budget used</span>
            <span className="text-right font-mono text-white/90">
              {execution.slippageBudgetUsedPercent}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
