'use client';

import { useEffect, useRef, useCallback } from 'react';

/**
 * Full-bleed animated gradient background with cursor-reactive radial highlight.
 * 
 * Uses CSS custom properties (--mx, --my) updated via mousemove for the pointer-tracking
 * radial gradient. Falls back to fixed center on touch devices. Respects prefers-reduced-motion
 * by disabling the tracking entirely.
 *
 * When a video file is available, swap the gradient div for a <video> element —
 * the component structure supports both via the same z-index layering.
 */
export function VideoBackground() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (rafRef.current !== null) return; // throttle to one per frame
    rafRef.current = requestAnimationFrame(() => {
      if (overlayRef.current) {
        overlayRef.current.style.setProperty('--mx', `${e.clientX}px`);
        overlayRef.current.style.setProperty('--my', `${e.clientY}px`);
      }
      rafRef.current = null;
    });
  }, []);

  useEffect(() => {
    /* Skip pointer tracking on touch-only devices or reduced motion */
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const isTouchOnly =
      'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;

    if (prefersReducedMotion || isTouchOnly) {
      /* Fixed center position fallback */
      if (overlayRef.current) {
        overlayRef.current.style.setProperty('--mx', '50%');
        overlayRef.current.style.setProperty('--my', '50%');
      }
      return;
    }

    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleMouseMove]);

  return (
    <div className="fixed inset-0 z-0" aria-hidden="true">
      {/* Base gradient — replaces video until an .mp4 is available */}
      <div className="absolute inset-0 bg-gradient-animated" />

      {/* Subtle animated grain/noise texture */}
      <div
        className="absolute inset-0 opacity-[0.015]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='1'/%3E%3C/svg%3E")`,
          backgroundSize: '128px 128px',
        }}
      />

      {/* Cursor-reactive radial gradient overlay */}
      <div
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none transition-none"
        style={{
          '--mx': '50%',
          '--my': '50%',
          background:
            'radial-gradient(600px circle at var(--mx) var(--my), rgba(255,255,255, 0.07), transparent 70%)',
        } as React.CSSProperties}
      />

      {/* Top fade for header readability */}
      <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-bg/80 to-transparent" />

      {/* Bottom fade */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-bg/60 to-transparent" />
    </div>
  );
}
