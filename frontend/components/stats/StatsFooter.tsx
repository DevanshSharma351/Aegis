'use client';

import React, { useEffect, useRef, useState } from 'react';

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

    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setValue(target);
      return;
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
    return () => cancelAnimationFrame(animationFrame);
  }, [isVisible, target, delay]);

  return (
    <div ref={cardRef} className="stat-card anim" style={{ '--d': delay } as React.CSSProperties}>
      <div className="stat-icon-custom">{icon}</div>
      <div className="stat-value">{value.toFixed(decimals)}{suffix}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
};

export const StatsFooter = () => {
  return (
    <footer className="stats-footer">
      <div className="stats-grid">
        <StatCard target={120} suffix="ms" decimals={0} icon="<" label="Inference Time" delay="0.5s" />
        <StatCard target={99.99} suffix="%" decimals={2} icon="%" label="Platform Uptime" delay="0.58s" />
        <StatCard target={24} suffix="/7" decimals={0} icon="*" label="Autonomous Runtime" delay="0.66s" />
        <StatCard target={2.4} suffix="M" decimals={1} icon="#" label="Context Windows" delay="0.74s" />
      </div>
    </footer>
  );
};
