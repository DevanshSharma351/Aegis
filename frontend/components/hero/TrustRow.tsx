'use client';

import { motion } from 'motion/react';

/* Protocol avatars as styled initials — these represent Ethereum, Phala, and
   Railgun, the three protocols whose attestation guarantees this system rests on.
   Not fake "trusted by" enterprise logos — an honest representation. */
const protocols = [
  { initial: 'Ξ', label: 'Ethereum', bg: 'from-indigo-500/20 to-indigo-600/20', border: 'border-indigo-500/30' },
  { initial: 'Ph', label: 'Phala Network', bg: 'from-green-500/20 to-emerald-500/20', border: 'border-green-500/30' },
  { initial: 'R', label: 'Railgun', bg: 'from-cyan-400/20 to-blue-500/20', border: 'border-cyan-400/30' },
];

export function TrustRow() {
  return (
    <motion.div
      className="anim flex items-center gap-3"
      style={{ '--d': '100ms' } as React.CSSProperties}
    >
      {/* Overlapping avatar ring */}
      <div className="flex -space-x-2">
        {protocols.map((p, i) => (
          <div
            key={p.label}
            className={`flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br ${p.bg} border ${p.border} text-xs font-semibold text-white/80 ring-2 ring-bg`}
            title={p.label}
            style={{ zIndex: protocols.length - i }}
          >
            {p.initial}
          </div>
        ))}
      </div>

      {/* Trust label pill */}
      <div className="flex items-center gap-2 rounded-full bg-trust-bg/60 border border-trust-border/20 px-3 py-1.5">
        <div className="h-1.5 w-1.5 rounded-full bg-shield-green animate-pulse" />
        <span className="text-xs font-medium text-trust-text">
          Verified by Independent Attestation
        </span>
      </div>
    </motion.div>
  );
}
