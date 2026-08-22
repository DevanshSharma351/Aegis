'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

export function TextMorph({
  children,
  className,
  style,
}: {
  children: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={children}
        initial={{ opacity: 0, filter: 'blur(4px)', y: -8 }}
        animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
        exit={{ opacity: 0, filter: 'blur(4px)', y: 8 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
        className={cn('inline-block whitespace-pre', className)}
        style={style}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
