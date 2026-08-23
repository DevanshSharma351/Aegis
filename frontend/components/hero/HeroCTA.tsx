'use client';

import { useRef, useState, useEffect } from 'react';
import { Cursor } from '@/components/core/cursor';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Wallet } from 'lucide-react';
import { useConnectModal, useAccountModal, useChainModal } from '@rainbow-me/rainbowkit';

export function HeroCTA({ isConnected, onClick }: { isConnected: boolean; onClick: () => void }) {
  const [isHovering, setIsHovering] = useState(false);
  const [isClicked, setIsClicked] = useState(false);
  const [overInteractive, setOverInteractive] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);

  const { connectModalOpen } = useConnectModal();
  const { accountModalOpen } = useAccountModal();
  const { chainModalOpen } = useChainModal();
  const isModalOpen = connectModalOpen || accountModalOpen || chainModalOpen;

  useEffect(() => {
    if (isModalOpen) {
      setIsHovering(false);
    }
  }, [isModalOpen]);

  const handlePositionChange = (x: number, y: number) => {
    if (targetRef.current && !isClicked && !isModalOpen) {
      const rect = targetRef.current.getBoundingClientRect();
      const isInside =
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      setIsHovering(isInside);
    } else if (isModalOpen) {
      setIsHovering(false);
    }

    // A cursor that never changes over a button is worse than the native one it
    // replaced: the pointer shape is how a page signals what can be clicked, and
    // hiding it without restoring that signal costs the user real information.
    // The stand-in is pointer-events-none, so it never occludes what it is over.
    const under = document.elementFromPoint(x, y);
    setOverInteractive(
      Boolean(
        under?.closest(
          'a, button, [role="button"], input, select, textarea, label, summary',
        ),
      ),
    );
  };

  const handleClick = () => {
    setIsClicked(true);
    setIsHovering(false);
    onClick();
    // Reset after a short delay in case they scroll back up
    setTimeout(() => setIsClicked(false), 1000);
  };

  return (
    <div className="relative flex h-2 w-full items-center justify-center anim" style={{ '--d': '0.4s' } as React.CSSProperties}>
      <Cursor
        attachToParent={false}
        // No region: the custom cursor replaces the native one across the whole
        // site. Safe only because Cursor ties the hiding rule to whether the
        // stand-in is actually drawn.
        variants={{
          initial: { scale: 0.3, opacity: 0 },
          animate: { scale: 1, opacity: 1 },
          exit: { scale: 0.3, opacity: 0 },
        }}
        springConfig={{
          stiffness: 800,
          damping: 28,
          mass: 0.1,
        }}
        transition={{
          ease: 'easeInOut',
          duration: 0.15,
        }}
        onPositionChange={handlePositionChange}
      >
        {/*
          Three states, because this is now the only cursor on the site:
            idle        a small solid dot, legible on any background
            interactive a ring that opens around what it is over
            hero CTA    a labelled pill
          The idle dot is opaque rather than the old 20% white -- at 16px and
          that opacity it was effectively invisible, which is why replacing the
          native pointer everywhere previously read as the cursor vanishing.
        */}
        <motion.div
          animate={{
            width: isHovering ? (isConnected ? 180 : 160) : overInteractive ? 38 : 12,
            height: isHovering ? 48 : overInteractive ? 38 : 12,
            backgroundColor: isHovering
              ? 'rgba(255,255,255,0.20)'
              : overInteractive
                ? 'rgba(255,255,255,0.10)'
                : 'rgba(255,255,255,0.92)',
            borderColor: overInteractive || isHovering
              ? 'rgba(255,255,255,0.55)'
              : 'rgba(0,0,0,0.25)',
          }}
          transition={{ type: 'spring', stiffness: 500, damping: 34, mass: 0.4 }}
          className="flex items-center justify-center rounded-full border backdrop-blur-md shadow-[0_0_12px_rgba(0,0,0,0.35)] pointer-events-none"
          style={{ borderRadius: isHovering ? 24 : 999 }}
        >
          <AnimatePresence>
            {isHovering && (
              <motion.div
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                className="inline-flex w-full items-center justify-center"
              >
                <div className="inline-flex items-center gap-2 text-sm font-medium text-white font-mono uppercase tracking-wider">
                  {isConnected ? (
                    <>Dashboard <ArrowRight className="w-4 h-4" /></>
                  ) : (
                    <>Connect <Wallet className="w-4 h-4" /></>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </Cursor>
      
      {/* Invisible clickable target area */}
      <div 
        ref={targetRef} 
        onClick={handleClick}
        className="cursor-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl h-80 z-40"
      />
    </div>
  );
}
