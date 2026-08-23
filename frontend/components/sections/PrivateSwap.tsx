'use client';

import React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  EyeOff,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { BorderTrail } from '@/components/core/border-trail';

import {
  formatUnits,
  usePrivateSwap,
  useRailgunStatus,
  useShieldedBalances,
} from '@/lib/hooks/usePrivateSwap';
import { explorerTx, truncateHash } from '@/lib/contracts';

/**
 * Private Swap — a first-class action, executed for real.
 *
 * Flow: this component → enclave (`/railgun/private-swap`) → Railgun sidecar →
 * POI check → atomic RelayAdapt transaction (unshield → Uniswap V3 → reshield)
 * → real Sepolia receipt → rendered here.
 *
 * There are no optimistic states and no synthetic hashes anywhere in this file.
 * The request does not resolve until the transaction is mined, so a hash is
 * shown only when a receipt exists behind it. Proof generation takes 1-3
 * minutes and the button says so, rather than showing a fake pending
 * confirmation that resolves on a timer.
 *
 * The two security modes are rendered from the backend's own report:
 *   POI        real | unconfigured   — was the Chainalysis list actually enforced
 *   Submission private | public      — did this avoid the public mempool
 */
export function PrivateSwap() {
  const status = useRailgunStatus();
  const { balances, railgunAddress, isLoading: balancesLoading, refresh } = useShieldedBalances();
  const { execute, reset, phase, result, error, startedAt } = usePrivateSwap();

  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (phase !== 'running' || !startedAt) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase, startedAt]);

  const weth = balances.find((b) => b.symbol === 'WETH');
  const spendable = weth ? BigInt(weth.spendable) : 0n;

  // Default to half the spendable balance, so a demo cannot accidentally
  // consume the entire shielded position in one click.
  const [amount, setAmount] = React.useState('');
  const suggested = spendable > 0n ? (spendable / 2n).toString() : '';
  const sellAmount = amount || suggested;

  const poiReal = status.poi.mode === 'real';
  const isPrivate = status.submission?.mode === 'private';
  const canRun = status.canSwap && spendable > 0n && phase !== 'running';

  return (
    <section id="private-swap" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="mb-12 text-center anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
        <h2 className="text-3xl md:text-5xl font-display mb-4 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
          Private Swap
        </h2>
        <p className="text-muted max-w-2xl mx-auto text-sm md:text-base leading-relaxed">
          One atomic transaction: unshield from Railgun, swap on Uniswap V3, reshield the proceeds.
          Nobody can wedge a transaction between those steps, and the 0zk owner is never revealed.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Security mode disclosure — always visible, never inferred         */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <StatusBadge
          ok={poiReal}
          icon={poiReal ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
          title={poiReal ? 'Proof of Innocence: REAL' : 'Proof of Innocence: NOT CONFIGURED'}
          detail={
            poiReal
              ? `Enforcing the required Chainalysis OFAC list via ${status.poi.nodeUrls.join(', ') || 'the configured aggregator'}.`
              : status.poi.note || 'No POI aggregator configured — spending shielded funds is disabled.'
          }
          mono={poiReal ? truncateHash(status.poi.requiredList, 10, 8) : undefined}
        />

        <StatusBadge
          ok={isPrivate}
          tone={isPrivate ? 'ok' : 'info'}
          icon={isPrivate ? <EyeOff className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          title={isPrivate ? 'Submission: PRIVATE' : 'Submission: PUBLIC'}
          detail={
            isPrivate
              ? `${status.submission?.route}. The transaction never enters the public mempool, so there is no pending transaction to target.`
              : `${status.submission?.route ?? 'public RPC'}. Two controls still apply: the swap is atomic, and the slippage floor is enforced on-chain by Uniswap. Sepolia has no MEV builder that will include a private transaction — verified by sending one and watching it go unmined for 25 blocks — so private submission here would buy privacy at the cost of never landing.`
          }
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* -------------------------------------------------------------- */}
        {/* Shielded position + action                                      */}
        {/* -------------------------------------------------------------- */}
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-6 relative overflow-hidden"
          style={{ '--d': '0.2s' } as React.CSSProperties}
        >
          <BorderTrail size={180} className="bg-accent/50" style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.3)' }} />

          <div className="flex items-center justify-between relative z-10">
            <h3 className="font-display tracking-wide text-lg text-white/90">Shielded Position</h3>
            <button
              onClick={refresh}
              className="text-muted hover:text-white transition-colors"
              aria-label="Refresh balances"
            >
              <RefreshCw className={`w-4 h-4 ${balancesLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="space-y-2 relative z-10">
            {balancesLoading && <p className="text-sm text-muted font-mono">Scanning merkletree…</p>}
            {!balancesLoading &&
              balances.map((b) => (
                <div
                  key={b.symbol}
                  className="flex justify-between items-baseline p-4 bg-black/40 rounded-xl border border-white/5"
                >
                  <span className="text-sm text-muted font-mono uppercase tracking-wider text-[11px]">
                    {b.symbol}
                  </span>
                  <div className="text-right">
                    <div className="font-mono text-white/90">{formatUnits(b.balance, b.decimals)}</div>
                    <div className="text-[10px] font-mono text-muted">
                      {formatUnits(b.spendable, b.decimals)} POI-spendable
                    </div>
                  </div>
                </div>
              ))}
          </div>

          {railgunAddress && (
            <div className="relative z-10">
              <span className="text-[10px] text-muted font-mono uppercase tracking-wider">0zk address</span>
              <code className="block mt-1 text-[10px] text-accent/70 font-mono break-all leading-relaxed">
                {railgunAddress}
              </code>
            </div>
          )}

          <div className="relative z-10 mt-auto space-y-3">
            <label className="block text-[11px] text-muted font-mono uppercase tracking-wider">
              WETH to swap (base units)
            </label>
            <input
              value={sellAmount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={suggested || '0'}
              className="w-full bg-black/60 border border-white/10 rounded-2xl px-5 py-4 text-white placeholder-white/30 focus:outline-none focus:border-accent transition-all font-mono text-sm"
            />
            {weth && (
              <p className="text-[10px] text-muted font-mono">
                = {formatUnits(sellAmount || '0', 18)} WETH · spendable {formatUnits(weth.spendable, 18)}
              </p>
            )}

            <button
              onClick={() => execute({ sellToken: 'WETH', buyToken: 'USDC', sellAmount, slippageBps: 150 })}
              disabled={!canRun || !sellAmount || BigInt(sellAmount || '0') > spendable}
              className="w-full flex items-center justify-center gap-2 bg-white text-black hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all rounded-2xl py-4 text-sm font-medium font-mono uppercase tracking-wider"
            >
              {phase === 'running' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating proof… {elapsed}s
                </>
              ) : (
                <>
                  Execute Private Swap <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            {phase === 'running' && (
              <p className="text-[10px] text-muted font-mono leading-relaxed">
                Generating a real Groth16 proof and waiting for inclusion. This typically takes
                1-3 minutes; nothing is shown until the transaction is actually mined.
              </p>
            )}

            {!status.canSwap && !status.isLoading && (
              <p className="text-[11px] text-amber-400/80 font-mono leading-relaxed">
                {status.error ?? 'Swap unavailable — see the status badges above.'}
              </p>
            )}
            {status.canSwap && spendable === 0n && !balancesLoading && (
              <p className="text-[11px] text-info/80 font-mono leading-relaxed">
                No POI-validated WETH to spend yet. A freshly shielded note becomes spendable once
                the aggregator validates it — usually a couple of minutes.
              </p>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------------- */}
        {/* Result — only ever backed by a real receipt                     */}
        {/* -------------------------------------------------------------- */}
        <div
          className="glass-light p-8 rounded-3xl anim flex flex-col gap-5 relative overflow-hidden"
          style={{ '--d': '0.3s' } as React.CSSProperties}
        >
          <BorderTrail
            size={180}
            className={phase === 'error' ? 'bg-red-500/50' : 'bg-shield-green/50'}
            style={{ boxShadow: '0 0 40px 10px rgba(74,222,128,0.2)' }}
          />

          <h3 className="font-display tracking-wide text-lg text-white/90 relative z-10">Execution Result</h3>

          {phase === 'idle' && (
            <p className="text-sm text-muted font-mono relative z-10">
              No swap executed in this session.
            </p>
          )}

          {phase === 'error' && (
            <div className="relative z-10 space-y-2">
              <div className="flex items-center gap-2 text-red-400">
                <XCircle className="w-5 h-5" />
                <span className="font-mono text-sm uppercase tracking-wider">Swap failed</span>
              </div>
              <p className="text-[11px] text-muted font-mono break-all leading-relaxed">{error}</p>
              <button onClick={reset} className="text-[11px] text-accent hover:text-accent/80 font-mono uppercase">
                Reset
              </button>
            </div>
          )}

          {phase === 'done' && result && (
            <div className="relative z-10 space-y-3 text-[12px] font-mono">
              <div className="flex items-center gap-2 text-shield-green">
                <CheckCircle2 className="w-5 h-5" />
                <span className="uppercase tracking-wider">Mined in block {result.blockNumber}</span>
              </div>

              <Row label="Sold" value={`${formatUnits(result.sellAmount, 18)} ${result.sellSymbol}`} />
              <Row label="Unshield fee" value={formatUnits(result.unshieldFee, 18)} />
              <Row label="Swapped" value={`${formatUnits(result.netSellAmount, 18)} ${result.sellSymbol}`} />
              <Row label="Received (quoted)" value={`${formatUnits(result.quotedBuyAmount, 6)} ${result.buySymbol}`} />
              <Row label="Slippage floor" value={`${formatUnits(result.minimumBuyAmount, 6)} ${result.buySymbol}`} />
              <Row label="Uniswap fee tier" value={`${result.feeTier / 10_000}%`} />
              <Row label="Proof time" value={`${(result.proofDurationMs / 1000).toFixed(1)}s`} />
              <Row label="Gas used" value={result.gasUsed} />
              <Row
                label="Submitted via"
                value={result.submission.mempoolExposed ? 'public mempool' : 'private relay'}
              />

              <a
                href={explorerTx(result.txHash)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-accent hover:text-accent/80 transition-colors pt-2 break-all"
              >
                {truncateHash(result.txHash, 12, 10)} <ArrowRight className="w-3 h-3 shrink-0" />
              </a>

              <p className="text-[10px] text-muted leading-relaxed pt-2 border-t border-white/5">
                On Etherscan this is a single interaction with Railgun&apos;s RelayAdapt contract. The
                amounts above are visible on-chain for this transaction — what stays hidden is which
                0zk address owns the funds, and the balance behind it.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted uppercase tracking-wider text-[10px] shrink-0">{label}</span>
      <span className="text-white/90 text-right break-all">{value}</span>
    </div>
  );
}

function StatusBadge({
  ok,
  tone: toneProp,
  icon,
  title,
  detail,
  mono,
}: {
  ok: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  mono?: string;
  tone?: 'ok' | 'info' | 'warn';
}) {
  // Three tones, not two. `ok=false` used to mean amber regardless of why, so a
  // deliberate and correct choice -- a public route on a chain with no builders
  // -- looked identical to something being broken. `tone="info"` says "this is
  // the accurate state, and it is fine"; amber is kept for actual faults.
  const tone = toneProp ?? (ok ? 'ok' : 'warn');
  const palette =
    tone === 'ok'
      ? { border: 'border-shield-green/20 bg-shield-green/5', fg: 'text-shield-green' }
      : tone === 'info'
        ? { border: 'border-info/20 bg-info/5', fg: 'text-info' }
        : { border: 'border-amber-400/20 bg-amber-400/5', fg: 'text-amber-400' };

  return (
    <div className={`rounded-2xl border p-5 flex gap-4 ${palette.border}`}>
      <div className={`${palette.fg} shrink-0`}>{icon}</div>
      <div className="min-w-0">
        <p className={`font-mono text-[11px] uppercase tracking-wider ${palette.fg}`}>
          {title}
        </p>
        <p className="text-[11px] text-muted mt-1 leading-relaxed">{detail}</p>
        {mono && <code className="block mt-1 text-[10px] text-muted/70 font-mono break-all">{mono}</code>}
      </div>
    </div>
  );
}
