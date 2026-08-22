'use client';

import React, { useRef, useState, useEffect } from 'react';
import { motion, useSpring, useMotionValue } from 'framer-motion';
import { cn } from '@/lib/utils';

export function Spotlight({
  className,
  size = 64,
}: {
  className?: string;
  size?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springConfig = { damping: 25, stiffness: 150, mass: 0.5 };
  const smoothX = useSpring(mouseX, springConfig);
  const smoothY = useSpring(mouseY, springConfig);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const { left, top } = containerRef.current.getBoundingClientRect();
      mouseX.set(e.clientX - left - size / 2);
      mouseY.set(e.clientY - top - size / 2);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [mouseX, mouseY, size]);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] z-0">
      <motion.div
        className={cn('absolute rounded-full bg-gradient-to-br', className)}
        style={{
          width: size,
          height: size,
          x: smoothX,
          y: smoothY,
        }}
      />
    </div>
  );
}
