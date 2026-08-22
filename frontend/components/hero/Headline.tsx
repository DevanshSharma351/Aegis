'use client';

import { motion } from 'motion/react';

export function Headline() {
  return (
    <div className="flex flex-col gap-1">
      <motion.h1
        className="anim leading-[0.95] tracking-tight text-text"
        style={
          {
            '--d': '200ms',
            fontSize: 'clamp(2.5rem, 8vw + 0.5rem, 6.5rem)',
            fontFamily: 'var(--font-silkscreen), monospace',
          } as React.CSSProperties
        }
      >
        Capital
      </motion.h1>
      <motion.h1
        className="anim leading-[0.95] tracking-tight"
        style={
          {
            '--d': '320ms',
            fontSize: 'clamp(2.5rem, 8vw + 0.5rem, 6.5rem)',
            fontFamily: 'var(--font-silkscreen), monospace',
          } as React.CSSProperties
        }
      >
        <span className="gradient-headline">
          Designed To Vanish
        </span>
      </motion.h1>
    </div>
  );
}
