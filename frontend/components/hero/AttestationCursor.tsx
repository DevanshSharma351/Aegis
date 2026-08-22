'use client';

import { useRef, useState } from 'react';
import { Cursor } from '@/components/core/cursor';
import { AnimatePresence, motion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';

/**
 * Wraps the attestation status badge with a motion-primitives Cursor.
 * Hovering reveals a "View Quote" action — thematically tying the cursor
 * interaction to the product's actual verify-the-proof function.
 */
export function AttestationCursor() {
  const [isHovering, setIsHovering] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);

  const handlePositionChange = (x: number, y: number) => {
    if (targetRef.current) {
      const rect = targetRef.current.getBoundingClientRect();
      const isInside =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      setIsHovering(isInside);
    }
  };

  return (
    <div className="relative inline-block">
      <Cursor
        attachToParent
        variants={{
          initial: { scale: 0.3, opacity: 0 },
          animate: { scale: 1, opacity: 1 },
          exit: { scale: 0.3, opacity: 0 },
        }}
        springConfig={{ bounce: 0.001 }}
        transition={{ ease: 'easeInOut', duration: 0.15 }}
        onPositionChange={handlePositionChange}
      >
        <motion.div
          animate={{
            width: isHovering ? 160 : 16,
            height: isHovering ? 32 : 16,
          }}
          className="flex items-center justify-center rounded-[24px] bg-gray-500/40 backdrop-blur-md"
        >
          <AnimatePresence>
            {isHovering ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                className="inline-flex w-full items-center justify-center"
              >
                <div className="inline-flex items-center text-sm text-white">
                  View Quote <ShieldCheck className="ml-1 h-4 w-4" />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </Cursor>

      {/* The attestation status badge — the interactive target */}
      <div ref={targetRef}>
        <div className="glass-light flex items-center gap-2 rounded-xl px-4 py-2.5 transition-colors hover:bg-white/[0.06]">
          <div className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-shield-green opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-shield-green" />
          </div>
          <span className="text-xs font-medium text-shield-green">
            TEE Attestation Active
          </span>
          <span className="text-xs text-muted">•</span>
          <span className="text-xs text-muted font-mono">
            Simulator Mode
          </span>
        </div>
      </div>
    </div>
  );
}
