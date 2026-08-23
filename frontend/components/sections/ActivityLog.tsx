'use client';

import React from 'react';
import { Activity, Clock, CheckCircle2, ArrowRight, Loader2, Inbox } from 'lucide-react';
import { BorderTrail } from '@/components/core/border-trail';

import { useExecutionLog, relativeTime } from '@/lib/hooks/useExecutionLog';
import { useSessionKeyPolicy } from '@/lib/hooks/useSessionKeyPolicy';
import { explorerTx, truncateHash } from '@/lib/contracts';

/**
 * The on-chain execution log, read live from Sepolia.
 *
 * PRIVACY: each entry shows a decision hash, a timestamp, and a sequence
 * number, because that is the entirety of what AegisVault emits. No amounts, no
 * allocations, no asset names — the contract has no field for them, and this
 * component does not go looking elsewhere to fill the gap. That absence is the
 * product working, not a missing feature.
 *
 * The previous version rendered three invented entries with fabricated
 * transaction hashes and linked them to etherscan.io (mainnet), where they do
 * not exist.
 */
export function ActivityLog() {
  const { entries, rebalanceCount, lastRebalanceAt, isLoading, error } = useExecutionLog();
  const policy = useSessionKeyPolicy();

  /**
   * Time until the rate limit allows another execution.
   *
   * Derived from the last on-chain rebalance plus the configured interval, not
   * a wall-clock countdown to an arbitrary hour.
   *
   * The only impure input is the current time, so that is isolated into a single
   * ticking state and everything else is derived from it. Reading `Date.now()`
   * in the render body would make the output depend on when React happened to
   * call the component; setting state from an effect body trips React 19's
   * set-state-in-effect rule. A timer callback is neither.
   */
  const [nowSeconds, setNowSeconds] = React.useState(() => Math.floor(Date.now() / 1000));

  React.useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * When the session key can next execute, and how much of its allowance is left.
   *
   * The policy permits N executions per interval, not one. This previously read
   * `lastRebalanceAt + interval`, which is only correct when N is 1 — after the
   * limit moved to 10/day it reported "rate-limited, 23h 28m" while eight
   * executions were still available, so the dashboard claimed the agent was
   * blocked when it was not.
   *
   * The window is measured from the events themselves rather than from the
   * vault's `lastRebalanceAt`, because only the events say *how many* landed
   * inside it. Once the allowance is spent, the wait is until the oldest
   * execution in the window ages out — that is the moment a slot frees.
   */
  const rateLimit = React.useMemo(() => {
    if (policy.isLoading || isLoading) return { label: '…', idle: false, used: null as number | null };

    const windowStart = nowSeconds - policy.rateLimitIntervalSeconds;
    const inWindow = entries
      .map((e) => e.timestamp)
      .filter((t) => t > windowStart)
      .sort((a, b) => a - b);

    const used = inWindow.length;
    if (used < policy.maxExecutionsPerDay) {
      return { label: 'ready now', idle: true, used };
    }

    const oldest = inWindow[0];
    const wait = oldest + policy.rateLimitIntervalSeconds - nowSeconds;
    if (wait <= 0) return { label: 'ready now', idle: true, used };

    const hours = Math.floor(wait / 3600);
    const minutes = Math.floor((wait % 3600) / 60);
    return { label: `${hours}h ${String(minutes).padStart(2, '0')}m`, idle: false, used };
  }, [
    policy.isLoading,
    policy.rateLimitIntervalSeconds,
    policy.maxExecutionsPerDay,
    isLoading,
    entries,
    nowSeconds,
  ]);

  const nextExecutionLabel = rateLimit.label;
  const agentIdle = rateLimit.idle;

  /**
   * Show a page at a time rather than the whole history.
   *
   * The log only grows, and rendering every entry makes the page longer with
   * each rebalance until the sections below it are unreachable without a long
   * scroll. Paging keeps the page a fixed height while still making the entire
   * history reachable — nothing is hidden, it is just not all at once.
   */
  const PAGE = 10;
  const [visible, setVisible] = React.useState(PAGE);
  const shown = entries.slice(0, visible);
  const remaining = entries.length - shown.length;

  return (
    <section id="logs" className="w-full max-w-5xl mx-auto py-24 px-6 relative z-10">
      <div className="flex flex-col md:flex-row gap-12">
        {/* -------------------------------------------------------------- */}
        {/* Status */}
        {/* -------------------------------------------------------------- */}
        <div className="md:w-1/3 flex flex-col gap-6 anim" style={{ '--d': '0.1s' } as React.CSSProperties}>
          <div>
            <h2 className="text-3xl font-display mb-3 tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
              Activity Log
            </h2>
            <p className="text-muted text-sm leading-relaxed">
              Every attested rebalance, read straight from the vault&apos;s event log. Amounts are
              absent because the contract never records them — the movement itself happens inside
              Railgun&apos;s shielded pool.
            </p>
          </div>

          <div className="glass-light p-8 rounded-3xl flex flex-col gap-5 border-l-4 border-l-accent relative overflow-hidden group hover:shadow-[0_0_40px_rgba(255,255,255,0.05)] transition-shadow duration-500">
            <BorderTrail
              size={180}
              className="bg-accent/50"
              style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.3)' }}
            />
            <div className="flex items-center gap-4 relative z-10">
              <div className="relative">
                {agentIdle && <div className="w-3.5 h-3.5 bg-accent rounded-full animate-ping absolute" />}
                <div className="w-3.5 h-3.5 bg-accent rounded-full relative z-10 shadow-[0_0_10px_#6366f1]" />
              </div>
              <h3 className="font-display tracking-wide text-lg text-white">
                Agent Status: {agentIdle ? 'Ready' : 'Rate-limited'}
              </h3>
            </div>

            <div className="flex items-center gap-3 text-[13px] text-muted relative z-10 font-mono uppercase tracking-wider">
              <Clock className="w-4 h-4 text-accent/80" />
              <span>
                Next execution{' '}
                <span className="font-mono text-white/90 bg-accent/10 px-2 py-0.5 rounded border border-accent/20">
                  {nextExecutionLabel}
                </span>
              </span>
            </div>

            <div className="relative z-10 pt-4 border-t border-white/5 text-[11px] font-mono uppercase tracking-wider text-muted">
              Rebalances recorded:{' '}
              <span className="text-white/90">{rebalanceCount ?? '…'}</span>
            </div>

            {/* "Ready" alone does not say how much allowance is left, which is
                the number that decides whether the next run will be refused. */}
            {rateLimit.used !== null && (
              <div className="text-[13px] text-muted relative z-10 font-mono uppercase tracking-wider mt-1">
                Allowance used:{' '}
                <span className="text-white/90">
                  {rateLimit.used} / {policy.maxExecutionsPerDay}
                </span>{' '}
                in the last {Math.round(policy.rateLimitIntervalSeconds / 3600)}h
              </div>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------------- */}
        {/* Timeline */}
        {/* -------------------------------------------------------------- */}
        <div
          className="md:w-2/3 glass-light rounded-3xl p-6 md:p-10 anim relative overflow-hidden group hover:border-white/20 transition-all duration-500"
          style={{ '--d': '0.2s' } as React.CSSProperties}
        >
          <BorderTrail
            size={300}
            className="bg-white/20"
            style={{ boxShadow: '0 0 40px 10px rgba(255,255,255,0.1)' }}
          />

          {isLoading && (
            <div className="flex items-center justify-center gap-3 py-16 text-muted text-sm font-mono">
              <Loader2 className="w-4 h-4 animate-spin" />
              Reading RebalanceExecuted events…
            </div>
          )}

          {!isLoading && error && (
            <div className="py-16 text-center">
              <p className="text-sm text-red-400/80 font-mono">Could not read the event log</p>
              <p className="mt-2 text-[11px] text-muted font-mono break-all max-w-md mx-auto">{error}</p>
            </div>
          )}

          {!isLoading && !error && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
              <Inbox className="w-8 h-8 opacity-40" />
              <p className="text-sm font-mono">No rebalances recorded yet</p>
              <p className="text-[11px] font-mono opacity-60">
                Run scripts/run_full_pipeline.sh to produce one
              </p>
            </div>
          )}

          {!isLoading && entries.length > 0 && (
            <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-px before:bg-gradient-to-b before:from-transparent before:via-white/15 before:to-transparent z-10">
              {shown.map((log) => (
                <div
                  key={`${log.txHash}-${log.sequence}`}
                  className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group/item is-active"
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-full border border-white/10 bg-black/80 glass-light text-muted group-hover/item:text-shield-green group-hover/item:border-shield-green/30 transition-all duration-300 shrink-0 md:order-1 md:group-odd/item:-translate-x-1/2 md:group-even/item:translate-x-1/2 shadow-xl z-10">
                    <Activity className="w-4 h-4" />
                  </div>

                  <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-black/40 p-5 rounded-2xl border border-white/5 group-hover/item:bg-white/[0.04] group-hover/item:border-white/10 transition-all duration-300 shadow-inner">
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-2">
                        <time className="text-[11px] text-muted font-mono uppercase tracking-wider">
                          {new Date(log.timestamp * 1000).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          <span className="opacity-50"> · {relativeTime(log.timestamp)}</span>
                        </time>
                        <div
                          className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-md border shrink-0 ${
                            log.hardwareVerified
                              ? 'text-shield-green bg-shield-green/10 border-shield-green/20'
                              : 'text-info/90 bg-info/10 border-info/20'
                          }`}
                          title={
                            log.hardwareVerified
                              ? 'TDX quote signature chain verified against Intel collateral'
                              : 'Attested by a TDX simulator — the quote was not checked against Intel collateral'
                          }
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {log.hardwareVerified ? 'Hardware attested' : 'Simulator attested'}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 mt-1">
                        <span className="text-sm font-medium text-white/90">
                          Rebalance #{log.sequence}
                        </span>
                        <a
                          href={explorerTx(log.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-[11px] text-accent/80 hover:text-accent font-mono tracking-wider transition-colors shrink-0"
                        >
                          {truncateHash(log.txHash, 8, 6)} <ArrowRight className="w-3 h-3" />
                        </a>
                      </div>

                      <div className="pt-2 border-t border-white/5">
                        <span className="text-[10px] text-muted font-mono uppercase tracking-wider">
                          Decision hash
                        </span>
                        <code className="block mt-1 text-[10px] text-accent/70 font-mono break-all leading-relaxed">
                          {log.decisionHash}
                        </code>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {remaining > 0 && (
                <div className="relative flex justify-center pt-2">
                  <button
                    onClick={() => setVisible((n) => n + PAGE)}
                    className="relative z-10 flex items-center gap-2 bg-black/70 hover:bg-white/[0.06] border border-white/10 hover:border-white/20 rounded-full px-5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-muted hover:text-white/90 transition-all"
                  >
                    Show {Math.min(PAGE, remaining)} more
                    <span className="opacity-50">({remaining} older)</span>
                  </button>
                </div>
              )}

              {remaining === 0 && entries.length > PAGE && (
                <div className="relative flex justify-center pt-2">
                  <button
                    onClick={() => setVisible(PAGE)}
                    className="relative z-10 bg-black/70 hover:bg-white/[0.06] border border-white/10 hover:border-white/20 rounded-full px-5 py-2.5 text-[11px] font-mono uppercase tracking-wider text-muted hover:text-white/90 transition-all"
                  >
                    Collapse to latest {PAGE}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
