'use client';

export function Subhead() {
  return (
    <p
      className="anim max-w-xl text-sm leading-relaxed text-muted sm:text-base"
      style={{ '--d': '440ms' } as React.CSSProperties}
    >
      An autonomous trading agent that reasons inside hardware-isolated compute
      and executes through shielded, MEV-proof rails — verifiable end-to-end,
      visible to no one.
    </p>
  );
}
