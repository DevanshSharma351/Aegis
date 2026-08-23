'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  motion,
  SpringOptions,
  useMotionValue,
  useSpring,
  AnimatePresence,
  Transition,
  Variant,
} from 'motion/react';
import { cn } from '@/lib/utils';
import { createPortal } from 'react-dom';

export type CursorProps = {
  children: React.ReactNode;
  className?: string;
  springConfig?: SpringOptions;
  attachToParent?: boolean;
  /**
   * CSS selector for the region this custom cursor replaces the native one in.
   *
   * Without it, a detached cursor hid the native pointer across the entire
   * document via `* { cursor: none !important }`, which is almost never what is
   * wanted: every button, link and input outside the decorated region also lost
   * its pointer, so the page read as unclickable even though the handlers were
   * firing normally.
   */
  hideNativeCursorWithin?: string;
  transition?: Transition;
  variants?: {
    initial: Variant;
    animate: Variant;
    exit: Variant;
  };
  onPositionChange?: (x: number, y: number) => void;
};

export function Cursor({
  children,
  className,
  springConfig,
  attachToParent,
  hideNativeCursorWithin,
  variants,
  transition,
  onPositionChange,
}: CursorProps) {
  const cursorX = useMotionValue(0);
  const cursorY = useMotionValue(0);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(
    !attachToParent && !hideNativeCursorWithin,
  );

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      cursorX.set(window.innerWidth / 2);
      cursorY.set(window.innerHeight / 2);
    }
  }, []);

  useEffect(() => {
    if (!attachToParent) {
      const style = document.createElement('style');
      style.id = 'global-cursor-none';
      // Scoped to the decorated region. Unscoped, this hid the pointer on the
      // whole page -- including the nav and every button below the fold.
      style.innerHTML = hideNativeCursorWithin
        ? `${hideNativeCursorWithin}, ${hideNativeCursorWithin} * { cursor: none !important; }`
        : '';
      document.head.appendChild(style);
    } else {
      document.body.style.cursor = 'auto';
    }

    const updatePosition = (e: MouseEvent) => {
      cursorX.set(e.clientX);
      cursorY.set(e.clientY);
      onPositionChange?.(e.clientX, e.clientY);

      // The blob stands in for the pointer, so it must only be drawn where the
      // pointer is actually hidden. Otherwise both are visible at once.
      if (!attachToParent && hideNativeCursorWithin) {
        const region = document.querySelector(hideNativeCursorWithin);
        if (region) {
          const r = region.getBoundingClientRect();
          setIsVisible(
            e.clientX >= r.left &&
              e.clientX <= r.right &&
              e.clientY >= r.top &&
              e.clientY <= r.bottom,
          );
        }
      }
    };

    const handleScroll = () => {
      onPositionChange?.(cursorX.get(), cursorY.get());
    };

    document.addEventListener('mousemove', updatePosition);
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('mousemove', updatePosition);
      window.removeEventListener('scroll', handleScroll);
      if (!attachToParent) {
        document.getElementById('global-cursor-none')?.remove();
      }
    };
  }, [cursorX, cursorY, onPositionChange, attachToParent, hideNativeCursorWithin]);

  const cursorXSpring = useSpring(cursorX, springConfig || { duration: 0 });
  const cursorYSpring = useSpring(cursorY, springConfig || { duration: 0 });

  useEffect(() => {
    const handleVisibilityChange = (visible: boolean) => {
      setIsVisible(visible);
    };

    const handleMouseEnter = () => {
      if (cursorRef.current?.parentElement) {
        cursorRef.current.parentElement.style.cursor = 'none';
      }
      handleVisibilityChange(true);
    };

    const handleMouseLeave = () => {
      if (cursorRef.current?.parentElement) {
        cursorRef.current.parentElement.style.cursor = 'auto';
      }
      handleVisibilityChange(false);
    };

    if (attachToParent && cursorRef.current) {
      const parent = cursorRef.current.parentElement;
      if (parent) {
        parent.addEventListener('mouseenter', handleMouseEnter);
        parent.addEventListener('mouseleave', handleMouseLeave);
      }
    }

    return () => {
      if (attachToParent && cursorRef.current) {
        const parent = cursorRef.current.parentElement;
        if (parent) {
          parent.removeEventListener('mouseenter', handleMouseEnter);
          parent.removeEventListener('mouseleave', handleMouseLeave);
        }
      }
    };
  }, [attachToParent]);

  if (!mounted) return null;

  return createPortal(
    <motion.div
      ref={cursorRef}
      className={cn('pointer-events-none fixed left-0 top-0', className)}
      style={{
        zIndex: 2147483647,
        x: cursorXSpring,
        y: cursorYSpring,
        translateX: '-50%',
        translateY: '-50%',
      }}
    >
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial='initial'
            animate='animate'
            exit='exit'
            variants={variants}
            transition={transition}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>,
    document.body
  );
}
