'use client';

import React from 'react';
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  Play,
  Shield,
  XCircle,
} from 'lucide-react';
import { BorderTrail } from '@/components/core/border-trail';

import { useAegisPipeline } from '@/lib/hooks/useAegisPipeline';
import { useDeposit, useWithdraw } from '@/lib/hooks/useVaultActions';
import {
  formatUnits,
  useRailgunStatus,
  useShieldedBalances,
} from '@/lib/hooks/usePrivateSwap';
import { explorerTx, truncateHash } from '@/lib/contracts';
import { MevProtection } from '@/components/sections/MevProtection';

/**
 * The Aegis user flow: Shield Funds, then Run Aegis.
 *
 * "Run Aegis" starts the pipeline that already exists in the enclave — the same
 * sequence scripts/run_full_pipeline.sh executes. The browser starts a job and
 * polls it; it does not orchestrate, decide, or sign anything.
 *
 * Every stage indicator below is the backend's own reported state. There are no
 * timers driving progress, and when a stage fails the ones after it stay
 * pending rather than being shown as complete.
 */
export function RunAegis({ isConnected }: { isConnected: boolean }) {
  const status = useRailgunStatus();
  const { balances, railgunAddress, isLoading: balancesLoading, refresh } = useShieldedBalances();
  const { run, reset, job, starting, startError, isRunning } = useAegisPipeline();
  const deposit = useDeposit();
  const withdrawAction = useWithdraw();
  const depositBusy = ['signing', 'building', 'approving', 'shielding'].includes(deposit.step);

  const weth = balances.find((b) => b.symbol === 'WETH');
  const spendable = weth ? BigInt(weth.spendable) : 0n;

  const [shieldAmount, setShieldAmount] = React.useState('2000000000000000');
  const [swapAmount, setSwapAmount] = React.useState('');
  const [withdrawSymbol, setWithdrawSymbol] = React.useState('WETH');
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const effectiveSwap = swapAmount || (spendable > 0n ? (spendable / 2n).toString() : '');

  // Refresh balances after a shield lands, so the position reflects reality
  // rather than needing a manual reload.
  React.useEffect(() => {
    if (deposit.step === 'done') refresh();
  }, [deposit.step, refresh]);

  React.useEffect(() => {
    if (withdrawAction.phase === 'done') refresh();
  }, [withdrawAction.phase, refresh]);

  React.useEffect(() => {
    if (job?.status === 'succeeded') refresh();
  }, [job?.status, refresh]);

  const decision = job?.result?.decision;
  const attestation = job?.result?.attestation;
  const vault = job?.result?.vault;
  const swap = job?.result?.swap;

  return (
    <section id="run-aegis" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="mb-10 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
          Run Aegis
        </h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          Shield capital, then let the agent decide and execute. The decision is made by a small
          language model running inside the TEE — you never interact with it directly, and neither
          does this page.
        </p>
      </div>

      {/* ================================================================ */}
      {/* Step 1 — Shield                                                   */}
      {/* ================================================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-5 relative overflow-hidden"
          style={{ '--d': '0.2s' } as React.CSSProperties}
        >
          <BorderTrail size={180} className="bg-accent/50" style={{ boxShadow: '0 0 40px 10px rgba(99,102,241,0.3)' }} />

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center border border-accent/20">
              <Shield className="text-accent w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display tracking-wide text-lg text-white/90">1 · Deposit</h3>
              <p className="text-[10px] text-muted font-mono uppercase tracking-wider mt-1">
                Your WETH → Railgun shielded pool
              </p>
            </div>
          </div>

          <div className="relative z-10 space-y-3">
            <input
              value={shieldAmount}
              onChange={(e) => setShieldAmount(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full bg-black/60 border border-white/10 rounded-2xl px-5 py-3 text-white focus:outline-none focus:border-accent transition-all font-mono text-sm"
            />
            <p className="text-[10px] text-muted font-mono">
              = {formatUnits(shieldAmount || '0', 18)} WETH (base units)
            </p>

            <button
              onClick={() => deposit.deposit('WETH', shieldAmount)}
              disabled={!isConnected || depositBusy || !shieldAmount}
              className="w-full flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 border border-white/10 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all rounded-2xl py-3 text-sm font-mono uppercase tracking-wider"
            >
              {depositBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {deposit.step === 'signing' && 'Sign in wallet…'}
                  {deposit.step === 'building' && 'Building…'}
                  {deposit.step === 'approving' && 'Approving…'}
                  {deposit.step === 'shielding' && 'Shielding…'}
                </>
              ) : (
                <>
                  Deposit from my wallet <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            <p className="text-[10px] text-muted font-mono leading-relaxed">
              {isConnected ? (
                <>Signed by {truncateHash(deposit.address ?? '', 6, 4)} — your wallet sends the
                  transaction, so the deposit is on-chain as yours.</>
              ) : (
                'Connect a wallet to enable.'
              )}
            </p>

            {deposit.step === 'done' && deposit.result && (
              <div className="rounded-xl border border-shield-green/20 bg-shield-green/5 p-3 text-[11px] font-mono space-y-1">
                <div className="flex items-center gap-2 text-shield-green">
                  <CheckCircle2 className="w-4 h-4" /> Deposited
                </div>
                <div className="text-muted">
                  {formatUnits(deposit.result.amount, 18)} {deposit.result.symbol} into the shielded pool
                </div>
                <a
                  href={explorerTx(deposit.result.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:text-accent/80 break-all block"
                >
                  {truncateHash(deposit.result.txHash, 12, 8)}
                </a>
              </div>
            )}

            {deposit.step === 'error' && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-[11px] font-mono text-red-400/90 break-all">
                {deposit.error}
              </div>
            )}
          </div>
        </div>

        {/* Shielded position */}
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-4 relative overflow-hidden"
          style={{ '--d': '0.25s' } as React.CSSProperties}
        >
          <h3 className="font-display tracking-wide text-lg text-white/90 relative z-10">
            Shielded Position
          </h3>
          <div className="space-y-2 relative z-10">
            {balancesLoading && <p className="text-sm text-muted font-mono">Scanning…</p>}
            {balances.map((b) => (
              <div
                key={b.symbol}
                className="flex justify-between items-baseline p-3 bg-black/40 rounded-xl border border-white/5"
              >
                <span className="text-[11px] text-muted font-mono uppercase">{b.symbol}</span>
                <div className="text-right font-mono">
                  <div className="text-white/90 text-sm">{formatUnits(b.balance, b.decimals)}</div>
                  <div className="text-[10px] text-muted">
                    {formatUnits(b.spendable, b.decimals)} POI-spendable
                  </div>
                </div>
              </div>
            ))}
          </div>
          {railgunAddress && (
            <code className="relative z-10 text-[9px] text-accent/60 font-mono break-all leading-relaxed">
              {railgunAddress}
            </code>
          )}

          {/* Withdraw. A pool with no exit is not a vault, it is a donation. */}
          <div className="relative z-10 pt-4 mt-1 border-t border-white/5 space-y-3">
            <p className="text-[10px] text-muted uppercase tracking-wider font-mono">Withdraw</p>

            <div className="flex gap-2">
              <select
                value={withdrawSymbol}
                onChange={(e) => setWithdrawSymbol(e.target.value)}
                className="bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-accent"
              >
                {balances.map((b) => (
                  <option key={b.symbol} value={b.symbol}>
                    {b.symbol}
                  </option>
                ))}
              </select>
              <input
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="amount in base units"
                className="flex-1 min-w-0 bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-accent"
              />
            </div>

            <button
              onClick={() => withdrawAction.withdraw(withdrawSymbol, withdrawAmount)}
              disabled={!isConnected || withdrawAction.phase === 'proving' || !withdrawAmount}
              className="w-full flex items-center justify-center gap-2 bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all rounded-xl py-2.5 text-xs font-mono uppercase tracking-wider"
            >
              {withdrawAction.phase === 'proving' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Proving… (1–3 min)
                </>
              ) : (
                <>Withdraw to my wallet</>
              )}
            </button>

            <p className="text-[10px] text-muted font-mono leading-relaxed">
              Spending a shielded note needs a Groth16 proof, so this takes a minute or two.
              Railgun charges 25 bps. Sent to {truncateHash(withdrawAction.address ?? '', 6, 4)}.
            </p>

            {withdrawAction.phase === 'done' && withdrawAction.result && (
              <div className="rounded-xl border border-shield-green/20 bg-shield-green/5 p-3 text-[11px] font-mono space-y-1">
                <div className="flex items-center gap-2 text-shield-green">
                  <CheckCircle2 className="w-4 h-4" /> Withdrawn
                </div>
                <div className="text-muted">
                  Received {withdrawAction.result.netAmount} (fee {withdrawAction.result.unshieldFee})
                </div>
                <a
                  href={explorerTx(withdrawAction.result.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:text-accent/80 break-all block"
                >
                  {truncateHash(withdrawAction.result.txHash, 12, 8)}
                </a>
              </div>
            )}

            {withdrawAction.phase === 'error' && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-[11px] font-mono text-red-400/90 break-all">
                {withdrawAction.error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Step 2 — Run                                                      */}
      {/* ================================================================ */}
      <div
        className="glass-light p-8 rounded-3xl anim relative overflow-hidden mb-6"
        style={{ '--d': '0.3s' } as React.CSSProperties}
      >
        <BorderTrail size={240} className="bg-shield-green/40" style={{ boxShadow: '0 0 40px 10px rgba(74,222,128,0.2)' }} />

        <div className="flex flex-col md:flex-row md:items-end gap-4 relative z-10">
          <div className="flex-1">
            <h3 className="font-display tracking-wide text-lg text-white/90 mb-1">
              2 · Run the agent
            </h3>
            <p className="text-[11px] text-muted font-mono leading-relaxed">
              Market analysis → SLM decision → TDX attestation → oracle → ERC-4337 → POI → private
              swap → reshield. Takes 2-5 minutes.
            </p>
          </div>

          <div className="md:w-64">
            <label className="block text-[10px] text-muted font-mono uppercase tracking-wider mb-1">
              WETH to trade
            </label>
            <input
              value={effectiveSwap}
              onChange={(e) => setSwapAmount(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-accent font-mono text-xs"
            />
            <p className="text-[9px] text-muted font-mono mt-1">
              {formatUnits(effectiveSwap || '0', 18)} WETH
            </p>
          </div>

          <button
            onClick={() => run({ sellAmount: effectiveSwap, slippageBps: 150 })}
            disabled={!isConnected || isRunning || starting || !status.canSwap || !effectiveSwap}
            className="flex items-center justify-center gap-2 bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all rounded-2xl px-8 py-3.5 text-sm font-medium font-mono uppercase tracking-wider"
          >
            {isRunning || starting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Running
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> Run Aegis
              </>
            )}
          </button>
        </div>

        {startError && (
          <p className="relative z-10 mt-4 text-[11px] font-mono text-red-400/90">{startError}</p>
        )}
        {!status.canSwap && !status.isLoading && (
          <p className="relative z-10 mt-4 text-[11px] font-mono text-amber-400/80">
            {status.error ?? 'Pipeline unavailable — check the Railgun status badges below.'}
          </p>
        )}
      </div>

      {/* ================================================================ */}
      {/* Stages                                                            */}
      {/* ================================================================ */}
      {job && (
        <div
          className="glass-light p-8 rounded-3xl anim relative overflow-hidden mb-6"
          style={{ '--d': '0.1s' } as React.CSSProperties}
        >
          <div className="flex items-center justify-between mb-6 relative z-10">
            <h3 className="font-display tracking-wide text-lg text-white/90">Execution</h3>
            <span
              className={`text-[10px] font-mono uppercase tracking-wider px-3 py-1 rounded-md border ${
                job.status === 'succeeded'
                  ? 'text-shield-green border-shield-green/30 bg-shield-green/10'
                  : job.status === 'failed'
                    ? 'text-red-400 border-red-400/30 bg-red-400/10'
                    : 'text-accent border-accent/30 bg-accent/10'
              }`}
            >
              {job.status}
            </span>
          </div>

          <ol className="space-y-1 relative z-10">
            {job.stages.map((stage) => (
              <li
                key={stage.key}
                className="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0"
              >
                <StageIcon status={stage.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={`text-sm font-mono ${
                        stage.status === 'succeeded'
                          ? 'text-white/90'
                          : stage.status === 'failed'
                            ? 'text-red-400'
                            : stage.status === 'running'
                              ? 'text-accent'
                              : 'text-muted'
                      }`}
                    >
                      {stage.label}
                    </span>
                    {stage.durationMs !== null && (
                      <span className="text-[10px] text-muted font-mono shrink-0">
                        {(stage.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  {stage.detail && (
                    <p
                      className={`text-[11px] font-mono mt-1 leading-relaxed break-words ${
                        stage.status === 'failed' ? 'text-red-400/80' : 'text-muted'
                      }`}
                    >
                      {stage.detail}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {job.status === 'failed' && (
            <div className="relative z-10 mt-5 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
              <p className="text-[11px] font-mono text-red-400 uppercase tracking-wider mb-1">
                Failed at: {job.failedStage}
              </p>
              <p className="text-[11px] font-mono text-muted leading-relaxed break-words">
                {job.error}
              </p>
              <button
                onClick={reset}
                className="mt-3 text-[11px] text-accent hover:text-accent/80 font-mono uppercase"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/* The decision                                                      */}
      {/* ================================================================ */}
      {decision && (
        <div
          className="glass-light p-8 rounded-3xl anim relative overflow-hidden mb-6"
          style={{ '--d': '0.1s' } as React.CSSProperties}
        >
          <div className="flex items-center gap-3 mb-5 relative z-10">
            <Brain className="w-5 h-5 text-accent" />
            <h3 className="font-display tracking-wide text-lg text-white/90">Agent Decision</h3>
            <span className="text-[9px] text-muted font-mono uppercase tracking-wider border border-white/10 rounded px-2 py-0.5">
              produced inside the enclave
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 relative z-10">
            <div className="space-y-2">
              {Object.entries(decision.allocations).map(([symbol, weight]) => (
                <div key={symbol}>
                  <div className="flex justify-between text-[11px] font-mono mb-1">
                    <span className="text-muted uppercase">{symbol}</span>
                    <span className="text-white/90">{(weight * 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-black/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${Math.max(0, Math.min(100, weight * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted font-mono pt-2">
                confidence {(decision.confidence * 100).toFixed(0)}%
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
                  Rationale
                </span>
                <p className="text-[12px] text-white/80 leading-relaxed mt-1">{decision.rationale}</p>
              </div>
              <div>
                <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
                  Decision hash
                </span>
                <code className="block text-[10px] text-accent/80 font-mono break-all mt-1">
                  {decision.decisionHash}
                </code>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* Result                                                            */}
      {/* ================================================================ */}
      {(vault || swap) && (
        <div
          className="glass-light p-8 rounded-3xl anim relative overflow-hidden"
          style={{ '--d': '0.1s' } as React.CSSProperties}
        >
          <h3 className="font-display tracking-wide text-lg text-white/90 mb-5 relative z-10">
            Execution Result
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative z-10 text-[12px] font-mono">
            <div className="space-y-2">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Attestation</p>
              {attestation && (
                <>
                  <KV k="Source" v={attestation.source} />
                  <KV k="Hardware verified" v={String(attestation.hardwareVerified)} />
                  <KV k="Measurement" v={truncateHash(attestation.measurement, 10, 8)} />
                  <KV k="Checks passed" v={String(attestation.checksPerformed.length)} />
                </>
              )}

              {vault && (
                <>
                  <p className="text-[10px] text-muted uppercase tracking-wider pt-3 mb-2">
                    AegisVault (ERC-4337)
                  </p>
                  <KV k="Sequence" v={`#${vault.sequence}`} />
                  <KV k="Block" v={vault.blockNumber} />
                  {vault.userOpHash && (
                    <KV k="UserOp" v={truncateHash(vault.userOpHash, 10, 6)} />
                  )}
                  <a
                    href={explorerTx(vault.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-accent hover:text-accent/80 break-all"
                  >
                    {truncateHash(vault.txHash, 12, 8)} <ChevronRight className="w-3 h-3 shrink-0" />
                  </a>
                </>
              )}
            </div>

            <div className="space-y-2">
              {swap ? (
                <>
                  <p className="text-[10px] text-muted uppercase tracking-wider mb-2">
                    Railgun private swap
                  </p>
                  <KV k="Sold" v={`${formatUnits(swap.sellAmount, 18)} WETH`} />
                  <KV k="Unshield fee" v={formatUnits(swap.unshieldFee, 18)} />
                  <KV k="Received (quoted)" v={`${formatUnits(swap.quotedBuyAmount, 6)} USDC`} />
                  <KV
                    k="Received (actual)"
                    v={`${formatUnits(swap.execution.actualBuyAmount, 6)} USDC`}
                  />
                  <KV k="Slippage floor" v={`${formatUnits(swap.minimumBuyAmount, 6)} USDC`} />
                  <KV k="Proof time" v={`${(swap.proofDurationMs / 1000).toFixed(1)}s`} />
                  <KV k="Gas used" v={swap.gasUsed} />
                  <a
                    href={explorerTx(swap.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-accent hover:text-accent/80 break-all"
                  >
                    {truncateHash(swap.txHash, 12, 8)} <ChevronRight className="w-3 h-3 shrink-0" />
                  </a>

                  <div className="pt-4 mt-3 border-t border-white/5">
                    <MevProtection
                      mempoolExposed={swap.submission.mempoolExposed}
                      route={swap.submission.route}
                      execution={swap.execution}
                      minimumBuyAmount={`${formatUnits(swap.minimumBuyAmount, 6)}`}
                    />
                  </div>
                </>
              ) : (
                <p className="text-muted text-[11px]">Swap not executed in this run.</p>
              )}
            </div>
          </div>

          {job?.result?.balances && (
            <div className="relative z-10 mt-6 pt-5 border-t border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider font-mono mb-2">
                Final shielded balance
              </p>
              <div className="flex flex-wrap gap-4 text-[12px] font-mono">
                {job.result.balances.map((b) => (
                  <span key={b.symbol} className="text-white/90">
                    {formatUnits(b.balance, b.decimals)}{' '}
                    <span className="text-muted">{b.symbol}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted shrink-0">{k}</span>
      <span className="text-white/90 text-right break-all">{v}</span>
    </div>
  );
}

function StageIcon({ status }: { status: string }) {
  const cls = 'w-4 h-4 shrink-0 mt-0.5';
  if (status === 'succeeded') return <CheckCircle2 className={`${cls} text-shield-green`} />;
  if (status === 'failed') return <XCircle className={`${cls} text-red-400`} />;
  if (status === 'running') return <Loader2 className={`${cls} text-accent animate-spin`} />;
  if (status === 'skipped') return <MinusCircle className={`${cls} text-muted/50`} />;
  return <Circle className={`${cls} text-muted/30`} />;
}
