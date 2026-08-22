'use client';

import { useRef, useState, useEffect } from 'react';
import { Cursor } from '@/components/core/cursor';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Wallet } from 'lucide-react';
import { useConnectModal, useAccountModal, useChainModal } from '@rainbow-me/rainbowkit';

export function HeroCTA({ isConnected, onClick }: { isConnected: boolean; onClick: () => void }) {
  const [isHovering, setIsHovering] = useState(false);
  const [isClicked, setIsClicked] = useState(false);
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
        <motion.div
          animate={{
            width: isHovering ? (isConnected ? 180 : 160) : 16,
            height: isHovering ? 48 : 16,
          }}
          className="flex items-center justify-center rounded-[24px] bg-white/20 backdrop-blur-md border border-white/10 shadow-[0_0_20px_rgba(255,255,255,0.1)] pointer-events-none"
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
