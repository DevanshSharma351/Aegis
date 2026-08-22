'use client';

import React, { useEffect, useRef, useState } from 'react';

import { useExecutionLog } from '@/lib/hooks/useExecutionLog';
import { useSessionKeyPolicy } from '@/lib/hooks/useSessionKeyPolicy';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

interface StatProps {
  target: number;
  suffix: string;
  decimals: number;
  icon: string;
  label: string;
  delay: string;
}

const StatCard = ({ target, suffix, decimals, icon, label, delay }: StatProps) => {
  const [value, setValue] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);

      // If the card is already within the viewport at mount, do not wait for an
      // intersection callback — in a background or non-compositing tab it may
      // never arrive.
      const rect = cardRef.current.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        setIsVisible(true);
        observer.disconnect();
      }
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    
    // Honour prefers-reduced-motion by snapping straight to the value. Deferred
    // to a timer rather than set synchronously in the effect body, which React
    // 19 flags as a cascading-render risk.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      const snap = setTimeout(() => setValue(target), 0);
      return () => clearTimeout(snap);
    }

    const duration = 1500;
    const delayMs = parseInt(delay) || 500;
    let startTime: number;
    let animationFrame: number;

    const update = (currentTime: number) => {
      if (!startTime) startTime = currentTime;
      const elapsed = currentTime - (startTime + delayMs);
      
      if (elapsed < 0) {
        animationFrame = requestAnimationFrame(update);
        return;
      }

      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      
      setValue(easedProgress * target);

      if (progress < 1) {
        animationFrame = requestAnimationFrame(update);
      } else {
        setValue(target);
      }
    };

    animationFrame = requestAnimationFrame(update);

    /**
     * Safety net: land on the true value even if the animation never runs.
     *
     * These targets are now live chain reads rather than constants, so a card
     * that fails to animate does not show a stale number — it shows 0, and
     * "0 Attested Rebalances" when the vault reports 1 is worse than no
     * animation at all. requestAnimationFrame is throttled to a standstill in
     * background tabs and paused entirely when the page is not compositing, so
     * this is a real path, not a theoretical one.
     */
    const settle = setTimeout(() => setValue(target), duration + delayMs + 250);

    return () => {
      cancelAnimationFrame(animationFrame);
      clearTimeout(settle);
    };
  }, [isVisible, target, delay]);

  return (
    <div ref={cardRef} className="stat-card anim" style={{ '--d': delay } as React.CSSProperties}>
      <div className="stat-icon-custom">{icon}</div>
      <div className="stat-value">{value.toFixed(decimals)}{suffix}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
};

/**
 * Four properties of this system, three of them read live from chain.
 *
 * The previous version showed "120ms Inference Time", "99.99% Platform Uptime",
 * "24/7 Autonomous Runtime" and "2.4M Context Windows" — none of which are
 * measured anywhere, and the uptime figure in particular is unknowable for a
 * hackathon deployment. These four are things that are actually true and, where
 * possible, verifiable by the reader on Etherscan.
 */
export const StatsFooter = () => {
  const { rebalanceCount, isLoading: logLoading } = useExecutionLog();
  const policy = useSessionKeyPolicy();

  return (
    <footer className="stats-footer">
      <div className="stats-grid">
        {/* Live: the vault's own counter. */}
        <StatCard
          target={rebalanceCount ?? 0}
          suffix={logLoading ? '…' : ''}
          decimals={0}
          icon="#"
          label="Attested Rebalances"
          delay="0.5s"
        />
        {/* Structurally 100%: rebalance() reverts unless the verifier accepts
            the proof, so an unattested rebalance cannot be recorded. */}
        <StatCard target={100} suffix="%" decimals={0} icon="%" label="On-Chain Verifiable" delay="0.58s" />
        {/* Live: from the session-key policy. */}
        <StatCard
          target={policy.maxExecutionsPerDay}
          suffix="/day"
          decimals={0}
          icon="*"
          label="Max Autonomous Executions"
          delay="0.66s"
        />
        {/* Live: derived from the compiled ABI, not asserted. */}
        <StatCard
          target={policy.hasNoWithdrawalFunction ? 0 : 1}
          suffix=""
          decimals={0}
          icon="<"
          label="Withdrawal Functions On Vault"
          delay="0.74s"
        />
      </div>
    </footer>
  );
};
