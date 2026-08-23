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
   * Region the custom cursor replaces the native one in. Omit for the whole
   * document.
   *
   * Going document-wide is only safe because the rule is tied to whether the
   * replacement is actually on screen (see below). An unconditional
   * `* { cursor: none }` is what made every button on the page read as dead:
   * the pointer was hidden everywhere while the stand-in was drawn nowhere.
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
    // Always starts hidden: the native pointer must not be hidden until the
    // replacement has actually been placed, which needs one mousemove.
    false,
  );

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      cursorX.set(window.innerWidth / 2);
      cursorY.set(window.innerHeight / 2);
    }
  }, []);

  /**
   * Hide the native pointer only while the stand-in is actually on screen.
   *
   * The rule used to be injected once on mount and left there for the life of
   * the component, which meant the native cursor was hidden inside the region
   * whether or not anything replaced it. Every way the blob could fail to draw
   * -- not yet mounted, reduced motion, the pointer already inside the region
   * on load so no mousemove had fired yet -- left that area with no cursor at
   * all, which reads as the page being broken.
   *
   * Tying the rule to `isVisible` inverts the failure: if the replacement is
   * not showing, the real pointer is. There is no state where neither is.
   */
  useEffect(() => {
    if (attachToParent) return;

    // Someone who has asked for reduced motion should not have their pointer
    // swapped for an animated one at all. Neither should a touch device, where
    // there is no pointer to replace and hiding it achieves nothing.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;

    const id = 'global-cursor-none';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }

    const scope = hideNativeCursorWithin
      ? `${hideNativeCursorWithin}, ${hideNativeCursorWithin} *`
      : '*';

    style.textContent = isVisible ? `${scope} { cursor: none !important; }` : '';

    // Leaving the rule behind on unmount would hide the pointer over a region
    // whose custom cursor no longer exists.
    return () => {
      document.getElementById(id)?.remove();
    };
  }, [isVisible, attachToParent, hideNativeCursorWithin]);

  useEffect(() => {
    if (attachToParent) {
      document.body.style.cursor = 'auto';
    }

    const updatePosition = (e: MouseEvent) => {
      cursorX.set(e.clientX);
      cursorY.set(e.clientY);
      onPositionChange?.(e.clientX, e.clientY);

      // The blob stands in for the pointer, so it is drawn exactly where the
      // pointer is hidden -- never both, never neither.
      if (attachToParent) return;

      if (!hideNativeCursorWithin) {
        setIsVisible(true);
        return;
      }

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
    };

    const handleScroll = () => {
      onPositionChange?.(cursorX.get(), cursorY.get());
    };

    // Leaving the window fires no mousemove, so without this the last known
    // position keeps the stand-in "inside" the region and the native pointer
    // stays hidden after the cursor has gone somewhere else entirely.
    const handleLeave = () => {
      if (!attachToParent) setIsVisible(false);
    };

    document.addEventListener('mousemove', updatePosition);
    document.addEventListener('mouseleave', handleLeave);
    window.addEventListener('blur', handleLeave);
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('mousemove', updatePosition);
      document.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('blur', handleLeave);
      window.removeEventListener('scroll', handleScroll);
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
