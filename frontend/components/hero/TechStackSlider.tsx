'use client';

import { InfiniteSlider } from '@/components/core/infinite-slider';

/**
 * Horizontal auto-scrolling strip showing the actual protocols this system's
 * guarantees rest on: Ethereum, Phala/dStack (TEE), Railgun (privacy), ERC-4337 (account abstraction).
 * 
 * This is a truthful "attested stack" display, not fake social proof.
 * Pauses on hover for readability.
 */
const techStack = [
  {
    name: 'Ethereum',
    icon: 'Ξ',
    gradient: 'from-indigo-400 to-blue-500',
    desc: 'Settlement Layer',
  },
  {
    name: 'Phala / dStack',
    icon: 'Ph',
    gradient: 'from-green-400 to-emerald-500',
    desc: 'TEE Attestation',
  },
  {
    name: 'Railgun',
    icon: 'R',
    gradient: 'from-cyan-400 to-blue-400',
    desc: 'Shielded Execution',
  },
  {
    name: 'ERC-4337',
    icon: '⬡',
    gradient: 'from-violet-400 to-purple-500',
    desc: 'Session Keys',
  },
  {
    name: 'Foundry',
    icon: 'F',
    gradient: 'from-orange-400 to-red-400',
    desc: 'Smart Contracts',
  },
  {
    name: 'ZeroDev',
    icon: 'Z',
    gradient: 'from-pink-400 to-rose-500',
    desc: 'Kernel Account',
  },
];

function TechBadge({
  name,
  icon,
  gradient,
  desc,
}: {
  name: string;
  icon: string;
  gradient: string;
  desc: string;
}) {
  return (
    <div className="glass-light flex items-center gap-3 rounded-xl px-4 py-2.5 whitespace-nowrap select-none">
      <div
        className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${gradient} text-sm font-bold text-white`}
      >
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-text">{name}</span>
        <span className="text-[10px] text-muted">{desc}</span>
      </div>
    </div>
  );
}

export function TechStackSlider() {
  return (
    <div
      className="anim w-full"
      style={{ '--d': '760ms' } as React.CSSProperties}
    >
      {/* Label */}
      <div className="mb-3 flex items-center gap-2 px-1">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted/60">
          Attested Stack
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
      </div>

      <InfiniteSlider
        gap={12}
        speed={30}
        speedOnHover={10}
        className="py-1"
      >
        {techStack.map((item) => (
          <TechBadge key={item.name} {...item} />
        ))}
      </InfiniteSlider>
    </div>
  );
}
